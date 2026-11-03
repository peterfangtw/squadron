using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

// Native CloseHandle produces EPIPE on the parent's next write. Node's fd 0
// close and stdin.destroy both accepted that write on Windows (2026-10-31).
class ClosedInputFixture
{
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int kind);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    static void Emit(object frame)
    {
        Console.WriteLine(Json.Serialize(frame));
        Console.Out.Flush();
    }

    static void Main(string[] args)
    {
        if (Array.IndexOf(args, "--version") >= 0) { Console.WriteLine("2.1.220"); return; }
        if (Array.IndexOf(args, "auth") >= 0) {
            Emit(new { loggedIn = true, authMethod = "claude.ai", email = "smoke@example.invalid", subscriptionType = "max" });
            return;
        }
        var sessionAt = Array.IndexOf(args, "--session-id");
        var session = sessionAt >= 0 ? args[sessionAt + 1] : Guid.NewGuid().ToString();
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            var frame = Json.Deserialize<Dictionary<string, object>>(line);
            if ((string)frame["type"] == "control_request") {
                Emit(new { type = "control_response", response = new {
                    subtype = "success", request_id = frame["request_id"], response = new {} } });
                continue;
            }
            if ((string)frame["type"] != "user") continue;
            Emit(new { type = "system", subtype = "init", session_id = session,
                cwd = Environment.CurrentDirectory, model = "claude-opus-5", tools = new string[0] });
            Emit(new { type = "result", subtype = "success", session_id = session, is_error = false });
            var marker = Path.Combine(Environment.GetEnvironmentVariable("HOME"), ".squadron", "fake-closed-input");
            while (File.ReadAllText(marker) != "close") Thread.Sleep(20);
            if (!CloseHandle(GetStdHandle(-10))) Environment.Exit(2);
            File.WriteAllText(marker, "closed");
            Thread.Sleep(Timeout.Infinite);
        }
    }
}
