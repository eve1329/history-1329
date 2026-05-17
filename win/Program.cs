using System.Diagnostics;
using System.Drawing;
using System.Security.Cryptography;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CodexHistoryViewer;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();

        using var context = new ViewerApplicationContext();
        Application.Run(context);
    }
}

internal sealed class ViewerApplicationContext : ApplicationContext
{
    private const string AppName = "Codex History Viewer";
    private const string Host = "127.0.0.1";

    private readonly NotifyIcon notifyIcon;
    private readonly HttpClient httpClient = new()
    {
        Timeout = TimeSpan.FromMilliseconds(1500)
    };

    private Process? serverProcess;
    private Form? viewerWindow;
    private WebView2? webView;
    private string startupOutput = "";
    private int port;
    private Uri? baseUri;
    private readonly string accessToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private bool exitRequested;

    public ViewerApplicationContext()
    {
        notifyIcon = new NotifyIcon
        {
            Icon = LoadIcon(),
            Text = AppName,
            Visible = true,
            ContextMenuStrip = BuildMenu()
        };
        notifyIcon.DoubleClick += async (_, _) => await OpenViewerAsync();

        Application.ApplicationExit += (_, _) => StopServer();
        AppDomain.CurrentDomain.ProcessExit += (_, _) => StopServer();

        _ = StartAsync();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            notifyIcon.Visible = false;
            notifyIcon.Dispose();
            httpClient.Dispose();
            StopServer();
        }

        base.Dispose(disposing);
    }

    private async Task StartAsync()
    {
        try
        {
            port = ResolvePort();
            baseUri = new Uri($"http://{Host}:{port}/");
            notifyIcon.Text = $"{AppName} {baseUri}";
            Log($"Launching {AppName} on {baseUri}");

            StartServerIfNeeded();

            if (await WaitForServerAsync())
            {
                await OpenViewerAsync();
                return;
            }

            ShowStartupError("无法连接到本地服务。");
        }
        catch (Exception error)
        {
            ShowStartupError(error.Message);
        }
    }

    private ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Viewer", null, async (_, _) => await OpenViewerAsync());
        menu.Items.Add("Open Log", null, (_, _) => OpenLog());
        menu.Items.Add("Restart Server", null, async (_, _) => await RestartServerAsync());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => Exit());
        return menu;
    }

    private static Icon LoadIcon()
    {
        var iconPath = Path.Combine(AppContext.BaseDirectory, "app.ico");
        if (File.Exists(iconPath))
        {
            return new Icon(iconPath);
        }

        return SystemIcons.Application;
    }

    private int ResolvePort()
    {
        var rawPort = Environment.GetEnvironmentVariable("CODEX_HISTORY_VIEWER_PORT");
        if (int.TryParse(rawPort, out var explicitPort) && explicitPort is >= 1 and <= 65535)
        {
            return explicitPort;
        }

        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private void StartServerIfNeeded()
    {
        if (baseUri is not null && IsServerListening(baseUri))
        {
            Log($"Server already listening on {baseUri}");
            return;
        }

        var viewerDir = Path.Combine(AppContext.BaseDirectory, "viewer");
        var serverPath = Path.Combine(viewerDir, "server.mjs");
        if (!File.Exists(serverPath))
        {
            throw new FileNotFoundException("Cannot find bundled viewer/server.mjs.", serverPath);
        }

        var nodePath = ResolveNodePath();
        if (nodePath is null)
        {
            throw new FileNotFoundException("Node.js was not found. The Windows package should include node\\node.exe, or Node 24+ must be available on PATH.");
        }

        Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);

        var environment = new Dictionary<string, string?>
        {
            ["HOST"] = Host,
            ["PORT"] = port.ToString(),
            ["CODEX_HISTORY_VIEWER_PORT"] = port.ToString(),
            ["CODEX_HISTORY_VIEWER_TOKEN"] = accessToken
        };

        var startInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = "server.mjs",
            WorkingDirectory = viewerDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };

        foreach (var entry in environment)
        {
            startInfo.Environment[entry.Key] = entry.Value ?? "";
        }

        serverProcess = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true
        };

        serverProcess.OutputDataReceived += (_, args) => CaptureOutput(args.Data);
        serverProcess.ErrorDataReceived += (_, args) => CaptureOutput(args.Data);
        serverProcess.Exited += (_, _) =>
        {
            if (!exitRequested)
            {
                Log($"Server process exited with code {serverProcess?.ExitCode}");
            }
        };

        if (!serverProcess.Start())
        {
            throw new InvalidOperationException("Failed to start bundled Node server.");
        }

        serverProcess.BeginOutputReadLine();
        serverProcess.BeginErrorReadLine();
        Log($"Started server process {serverProcess.Id} with {nodePath}");
    }

    private static string? ResolveNodePath()
    {
        var overridePath = Environment.GetEnvironmentVariable("CODEX_HISTORY_VIEWER_NODE");
        if (!string.IsNullOrWhiteSpace(overridePath) && File.Exists(overridePath))
        {
            return overridePath;
        }

        var bundled = Path.Combine(AppContext.BaseDirectory, "node", "node.exe");
        if (File.Exists(bundled))
        {
            return bundled;
        }

        var pathValue = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var pathDir in pathValue.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var candidate = Path.Combine(pathDir, "node.exe");
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    private static bool IsServerListening(Uri uri)
    {
        try
        {
            using var client = new TcpClient();
            var task = client.ConnectAsync(uri.Host, uri.Port);
            return task.Wait(TimeSpan.FromMilliseconds(250)) && client.Connected;
        }
        catch
        {
            return false;
        }
    }

    private async Task<bool> WaitForServerAsync()
    {
        if (baseUri is null)
        {
            return false;
        }

        var healthUri = new Uri(baseUri, "api/health");
        for (var attempt = 0; attempt < 80; attempt += 1)
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, healthUri);
                request.Headers.Add("X-Codex-History-Token", accessToken);
                using var response = await httpClient.SendAsync(request);
                if (response.IsSuccessStatusCode)
                {
                    return true;
                }
            }
            catch
            {
                // The Node process can take a moment to bind the port.
            }

            await Task.Delay(250);
        }

        return false;
    }

    private async Task OpenViewerAsync()
    {
        if (baseUri is null)
        {
            return;
        }

        try
        {
            if (viewerWindow is null || viewerWindow.IsDisposed)
            {
                viewerWindow = BuildViewerWindow();
            }

            viewerWindow.Show();
            viewerWindow.WindowState = FormWindowState.Normal;
            viewerWindow.Activate();

            if (webView is not null)
            {
                await EnsureWebViewReadyAsync();
                webView.CoreWebView2.Navigate(ViewerUrl);
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private Form BuildViewerWindow()
    {
        var form = new Form
        {
            Text = AppName,
            Width = 1220,
            Height = 820,
            StartPosition = FormStartPosition.CenterScreen
        };
        form.FormClosing += (_, args) =>
        {
            if (!exitRequested)
            {
                args.Cancel = true;
                form.Hide();
            }
        };

        webView = new WebView2
        {
            Dock = DockStyle.Fill
        };
        form.Controls.Add(webView);
        return form;
    }

    private async Task EnsureWebViewReadyAsync()
    {
        if (webView is null || webView.CoreWebView2 is not null)
        {
            return;
        }

        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "CodexHistoryViewer",
            "WebView2"
        );
        Directory.CreateDirectory(userDataFolder);
        var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);
        await webView.EnsureCoreWebView2Async(environment);
        webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
    }

    private string ViewerUrl
    {
        get
        {
            var builder = new UriBuilder(baseUri!)
            {
                Query = $"access_token={Uri.EscapeDataString(accessToken)}"
            };
            return builder.Uri.ToString();
        }
    }

    private async Task RestartServerAsync()
    {
        StopServer();
        startupOutput = "";
        try
        {
            StartServerIfNeeded();
            if (await WaitForServerAsync())
            {
                await OpenViewerAsync();
                return;
            }

            ShowStartupError("重启后仍无法连接到本地服务。");
        }
        catch (Exception error)
        {
            ShowStartupError(error.Message);
        }
    }

    private void Exit()
    {
        exitRequested = true;
        notifyIcon.Visible = false;
        viewerWindow?.Close();
        webView?.Dispose();
        viewerWindow?.Dispose();
        StopServer();
        ExitThread();
    }

    private void StopServer()
    {
        var process = serverProcess;
        serverProcess = null;
        if (process is null)
        {
            return;
        }

        try
        {
            if (!process.HasExited)
            {
                Log($"Stopping server process {process.Id}");
                process.Kill(entireProcessTree: true);
                process.WaitForExit(1500);
            }
        }
        catch
        {
            // Exit should stay quiet; the next launch can start a fresh server.
        }
        finally
        {
            process.Dispose();
        }
    }

    private void ShowStartupError(string message)
    {
        var details = startupOutput.Trim();
        var text = $"""
        {message}

        请确认此目录包含 bundled Node 24+，或设置 CODEX_HISTORY_VIEWER_NODE 指向 node.exe。

        日志：{LogPath}

        {details}
        """;

        MessageBox.Show(text, $"{AppName} 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        OpenLog();
        Exit();
    }

    private static void OpenLog()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
            if (!File.Exists(LogPath))
            {
                File.WriteAllText(LogPath, "");
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = LogPath,
                UseShellExecute = true
            });
        }
        catch
        {
            // The message box already shows the log path.
        }
    }

    private void CaptureOutput(string? line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return;
        }

        startupOutput += line + Environment.NewLine;
        if (startupOutput.Length > 6000)
        {
            startupOutput = startupOutput[^6000..];
        }

        Log(line);
    }

    private static void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
            File.AppendAllText(LogPath, $"[{DateTimeOffset.Now:O}] {message}{Environment.NewLine}");
        }
        catch
        {
            // Logging should never prevent the viewer from opening.
        }
    }

    private static string LogPath
    {
        get
        {
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var root = string.IsNullOrWhiteSpace(localAppData)
                ? Path.GetTempPath()
                : Path.Combine(localAppData, "CodexHistoryViewer");
            return Path.Combine(root, "codex-history-viewer.log");
        }
    }
}
