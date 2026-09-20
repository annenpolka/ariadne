// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AriadneNative",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "AriadneFixture", targets: ["AriadneFixture"]),
        .executable(name: "AriadneAXProbe", targets: ["AriadneAXProbe"]),
        .executable(name: "AriadneHost", targets: ["AriadneHost"]),
    ],
    targets: [
        .executableTarget(name: "AriadneFixture"),
        .executableTarget(name: "AriadneAXProbe"),
        // Swift 5 language mode keeps the C-style AX callback and serial-queue
        // plumbing readable; the compiler is still Swift 6.
        .executableTarget(name: "AriadneHost", swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "AriadneHostTests", dependencies: ["AriadneHost"], swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
