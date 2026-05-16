import AppKit
import Foundation

let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

let iconEntries: [(name: String, pixels: Int)] = [
  ("icon_16x16.png", 16),
  ("icon_16x16@2x.png", 32),
  ("icon_32x32.png", 32),
  ("icon_32x32@2x.png", 64),
  ("icon_128x128.png", 128),
  ("icon_128x128@2x.png", 256),
  ("icon_256x256.png", 256),
  ("icon_256x256@2x.png", 512),
  ("icon_512x512.png", 512),
  ("icon_512x512@2x.png", 1024)
]

func drawRoundedRect(_ rect: CGRect, radius: CGFloat, color: NSColor) {
  color.setFill()
  NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
}

func drawLine(from start: CGPoint, to end: CGPoint, width: CGFloat, color: NSColor, cap: NSBezierPath.LineCapStyle = .round) {
  let path = NSBezierPath()
  path.move(to: start)
  path.line(to: end)
  path.lineWidth = width
  path.lineCapStyle = cap
  color.setStroke()
  path.stroke()
}

func drawArc(center: CGPoint, radius: CGFloat, startAngle: CGFloat, endAngle: CGFloat, width: CGFloat, color: NSColor) {
  let path = NSBezierPath()
  path.appendArc(withCenter: center, radius: radius, startAngle: startAngle, endAngle: endAngle, clockwise: false)
  path.lineWidth = width
  path.lineCapStyle = .round
  color.setStroke()
  path.stroke()
}

func drawArrowHead(at tip: CGPoint, angleDegrees: CGFloat, size: CGFloat, color: NSColor) {
  let angle = angleDegrees * .pi / 180
  let left = CGPoint(
    x: tip.x - cos(angle - 0.72) * size,
    y: tip.y - sin(angle - 0.72) * size
  )
  let right = CGPoint(
    x: tip.x - cos(angle + 0.72) * size,
    y: tip.y - sin(angle + 0.72) * size
  )
  let path = NSBezierPath()
  path.move(to: tip)
  path.line(to: left)
  path.line(to: right)
  path.close()
  color.setFill()
  path.fill()
}

func renderIcon(size: Int) throws -> NSBitmapImageRep {
  let dimension = CGFloat(size)
  let scale = dimension / 1024.0
  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: size,
    pixelsHigh: size,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else {
    throw NSError(domain: "IconGenerator", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to create bitmap"])
  }

  bitmap.size = NSSize(width: dimension, height: dimension)

  NSGraphicsContext.saveGraphicsState()
  let context = NSGraphicsContext(bitmapImageRep: bitmap)
  NSGraphicsContext.current = context
  context?.imageInterpolation = .high
  context?.shouldAntialias = true

  func rect(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat) -> CGRect {
    CGRect(x: x * scale, y: y * scale, width: width * scale, height: height * scale)
  }

  func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
    CGPoint(x: x * scale, y: y * scale)
  }

  let canvas = rect(0, 0, 1024, 1024)
  NSColor.clear.setFill()
  canvas.fill()

  let base = rect(84, 84, 856, 856)
  let basePath = NSBezierPath(roundedRect: base, xRadius: 190 * scale, yRadius: 190 * scale)
  let baseGradient = NSGradient(colors: [
    NSColor(calibratedRed: 0.055, green: 0.074, blue: 0.105, alpha: 1),
    NSColor(calibratedRed: 0.105, green: 0.135, blue: 0.190, alpha: 1),
    NSColor(calibratedRed: 0.047, green: 0.090, blue: 0.130, alpha: 1)
  ])
  NSGraphicsContext.saveGraphicsState()
  basePath.addClip()
  baseGradient?.draw(in: base, angle: -38)
  NSGraphicsContext.restoreGraphicsState()

  let rim = NSBezierPath(roundedRect: base.insetBy(dx: 18 * scale, dy: 18 * scale), xRadius: 170 * scale, yRadius: 170 * scale)
  NSColor(calibratedRed: 1, green: 1, blue: 1, alpha: 0.10).setStroke()
  rim.lineWidth = 3.5 * scale
  rim.stroke()

  let glow = NSBezierPath(ovalIn: rect(566, 512, 310, 310))
  NSColor(calibratedRed: 0.13, green: 0.72, blue: 0.76, alpha: 0.20).setFill()
  glow.fill()

  let cardShadow = NSShadow()
  cardShadow.shadowColor = NSColor.black.withAlphaComponent(0.32)
  cardShadow.shadowOffset = NSSize(width: 0, height: -18 * scale)
  cardShadow.shadowBlurRadius = 28 * scale

  NSGraphicsContext.saveGraphicsState()
  cardShadow.set()
  drawRoundedRect(rect(256, 312, 430, 330), radius: 64 * scale, color: NSColor(calibratedRed: 0.48, green: 0.56, blue: 0.68, alpha: 0.48))
  NSGraphicsContext.restoreGraphicsState()

  drawRoundedRect(rect(302, 382, 438, 322), radius: 66 * scale, color: NSColor(calibratedRed: 0.73, green: 0.80, blue: 0.88, alpha: 0.88))

  let frontPath = NSBezierPath(roundedRect: rect(350, 438, 438, 326), xRadius: 66 * scale, yRadius: 66 * scale)
  let frontGradient = NSGradient(colors: [
    NSColor(calibratedRed: 0.985, green: 0.992, blue: 1.0, alpha: 1),
    NSColor(calibratedRed: 0.845, green: 0.890, blue: 0.955, alpha: 1)
  ])
  frontGradient?.draw(in: frontPath, angle: 90)

  NSColor(calibratedRed: 0.06, green: 0.10, blue: 0.16, alpha: 0.16).setStroke()
  frontPath.lineWidth = 2.5 * scale
  frontPath.stroke()

  drawRoundedRect(rect(408, 676, 230, 28), radius: 14 * scale, color: NSColor(calibratedRed: 0.12, green: 0.18, blue: 0.27, alpha: 0.74))
  drawRoundedRect(rect(408, 606, 310, 22), radius: 11 * scale, color: NSColor(calibratedRed: 0.20, green: 0.31, blue: 0.43, alpha: 0.30))
  drawRoundedRect(rect(408, 556, 248, 22), radius: 11 * scale, color: NSColor(calibratedRed: 0.20, green: 0.31, blue: 0.43, alpha: 0.24))
  drawRoundedRect(rect(408, 506, 288, 22), radius: 11 * scale, color: NSColor(calibratedRed: 0.20, green: 0.31, blue: 0.43, alpha: 0.20))

  let teal = NSColor(calibratedRed: 0.12, green: 0.76, blue: 0.72, alpha: 1)
  let tealSoft = NSColor(calibratedRed: 0.36, green: 0.93, blue: 0.86, alpha: 1)
  drawArc(center: point(512, 512), radius: 318 * scale, startAngle: 212, endAngle: 35, width: 70 * scale, color: teal)
  drawArc(center: point(512, 512), radius: 318 * scale, startAngle: 212, endAngle: 35, width: 30 * scale, color: tealSoft.withAlphaComponent(0.42))
  drawArrowHead(at: point(760, 716), angleDegrees: 28, size: 86 * scale, color: teal)

  let clockCenter = point(282, 694)
  let clockRing = NSBezierPath(ovalIn: rect(216, 628, 132, 132))
  NSColor(calibratedRed: 0.94, green: 0.98, blue: 1.0, alpha: 0.96).setFill()
  clockRing.fill()
  NSColor(calibratedRed: 0.10, green: 0.22, blue: 0.34, alpha: 0.22).setStroke()
  clockRing.lineWidth = 4 * scale
  clockRing.stroke()
  drawLine(from: clockCenter, to: point(282, 724), width: 10 * scale, color: NSColor(calibratedRed: 0.08, green: 0.16, blue: 0.25, alpha: 0.74))
  drawLine(from: clockCenter, to: point(310, 676), width: 10 * scale, color: NSColor(calibratedRed: 0.08, green: 0.16, blue: 0.25, alpha: 0.74))

  drawRoundedRect(rect(664, 388, 116, 62), radius: 31 * scale, color: NSColor(calibratedRed: 0.13, green: 0.77, blue: 0.42, alpha: 1))
  drawLine(from: point(690, 419), to: point(716, 397), width: 13 * scale, color: .white)
  drawLine(from: point(716, 397), to: point(756, 435), width: 13 * scale, color: .white)

  NSGraphicsContext.restoreGraphicsState()
  return bitmap
}

func writePNG(_ bitmap: NSBitmapImageRep, to url: URL) throws {
  guard let png = bitmap.representation(using: .png, properties: [:]) else {
    throw NSError(domain: "IconGenerator", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to encode PNG"])
  }
  try png.write(to: url)
}

for entry in iconEntries {
  let bitmap = try renderIcon(size: entry.pixels)
  try writePNG(bitmap, to: outputDirectory.appendingPathComponent(entry.name))
}
