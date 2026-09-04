import Foundation

/// One-shot resolver for a usable child-process environment.
///
/// Why this exists: when the widget runs under launchd, its PATH is the
/// minimal `/usr/bin:/bin:/usr/sbin:/sbin` and never contains user-installed
/// bun (Homebrew, ~/.bun, custom dirs). The bash CLI we spawn then fails with
/// "bun not found" → exit 1. We probe the user's actual login shell once at
/// app start and cache the result, then hand it to every `Process` we spawn.
///
/// Failure-isolated: if discovery fails, we fall back to a hard-coded list of
/// common locations. The widget keeps running regardless.
struct ShellEnvironment {
    let path: String
    let bunPath: String?

    /// Augment the given env with this PATH and (if found) CURSOR_API_PROXY_BUN.
    func apply(to env: [String: String]) -> [String: String] {
        var out = env
        out["PATH"] = path
        if let bun = bunPath, env["CURSOR_API_PROXY_BUN"] == nil {
            out["CURSOR_API_PROXY_BUN"] = bun
        }
        return out
    }

    static func discover() -> ShellEnvironment {
        let fallbackDirs = candidateDirs()
        let loginPath = readLoginShellPath()
        let mergedPath = mergePaths(loginPath, fallbackDirs)
        let bun = findExecutable("bun", in: mergedPath)
        return ShellEnvironment(path: mergedPath, bunPath: bun)
    }

    // MARK: - helpers

    private static func candidateDirs() -> [String] {
        let home = NSHomeDirectory()
        var dirs = [
            "\(home)/.bun/bin",
            "\(home)/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "\(home)/.volta/bin",
            "\(home)/.asdf/shims",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        return dirs
    }

    /// Ask the user's login shell to print its PATH. Bounded with a short
    /// timeout so a broken shell init can't hang the widget.
    private static func readLoginShellPath() -> String? {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell)
        p.arguments = ["-lc", "printf %s \"$PATH\""]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(2.0)
        while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if p.isRunning { p.terminate(); return nil }
        var data = Data()
        if let payload = (try? out.fileHandleForReading.readToEnd()) ?? nil {
            data = payload
        }
        let s = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return s.isEmpty ? nil : s
    }

    private static func mergePaths(_ first: String?, _ extra: [String]) -> String {
        var seen = Set<String>()
        var out: [String] = []
        let push: (String) -> Void = { dir in
            let t = dir.trimmingCharacters(in: .whitespaces)
            guard !t.isEmpty, !seen.contains(t) else { return }
            seen.insert(t)
            out.append(t)
        }
        first?.split(separator: ":").forEach { push(String($0)) }
        extra.forEach(push)
        return out.joined(separator: ":")
    }

    private static func findExecutable(_ name: String, in path: String) -> String? {
        for dir in path.split(separator: ":") {
            let candidate = "\(dir)/\(name)"
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }
}
