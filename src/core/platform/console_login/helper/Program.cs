using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Squadron.ConsoleLogin {
  internal static class Program {
    static readonly Stream Input = Console.OpenStandardInput(), Output = Console.OpenStandardOutput();
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength = 98304, RecursionLimit = 8 }; }
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    static readonly object Gate = new object(), QueueGate = new object();
    static readonly Queue<byte[]> Queue = new Queue<byte[]>();
    static readonly AutoResetEvent Queued = new AutoResetEvent(false);
    static readonly ManualResetEvent Drained = new ManualResetEvent(true);
    static IntPtr owner, job;
    static long expires;
    static int ending, braking, completing, total, queued;
    static volatile bool finished, launched, isolatedConsole;
    static string nonce;
    static string stopReason = "stopped";
    static Native.Handler handler;

    public static int Main(string[] args) {
      new Thread(Watch) { IsBackground = true }.Start();
      try {
        Require(Native.Target(), "target-or-framework");
        using (var impersonation = WindowsIdentity.GetCurrent(true)) Require(impersonation == null, "impersonation");
        if (args.Length == 2 && args[0] == "owner-identity") {
          using (var caller = new Owner(int.Parse(args[1]), null)) {
            Write(1, Utf8.GetBytes(Json().Serialize(new { version = 1, pid = int.Parse(args[1]), birth = caller.Birth })));
          }
          return 0;
        }
        Require(args.Length == 0, "arguments");
        var start = Control();
        Require(start.Count == 9 && Number(start, "version") == 1 && Text(start, "kind") == "start", "protocol");
        nonce = Text(start, "nonce");
        Require(System.Text.RegularExpressions.Regex.IsMatch(nonce, "\\A[0-9a-f]{32}\\z"), "nonce");
        expires = Number(start, "expires");
        Require(expires > Utc() && expires <= Utc() + 300000, "expiry");
        string image = Text(start, "image"), cwd = Text(start, "cwd");
        Require(Absolute(image) && Absolute(cwd) && (image.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || image.EndsWith(".com", StringComparison.OrdinalIgnoreCase)), "invocation");
        var arguments = start["args"] as object[];
        Require(arguments != null && arguments.Length <= 4096, "argv");
        var command = new StringBuilder(Quote(image));
        foreach (object value in arguments) {
          var text = value as string;
          Require(text != null && text.IndexOf('\0') < 0, "argv");
          command.Append(' ').Append(Quote(text));
          Require(command.Length <= 32766, "command-limit");
        }
        Require(command.Length <= 32766, "command-limit");
        long pid = Number(start, "ownerPid"); Require(pid > 0 && pid <= int.MaxValue, "owner-pid");
        using (var caller = new Owner((int)pid, Text(start, "ownerBirth"))) {
          owner = caller.Handle;
          job = Native.CreateJobObject(IntPtr.Zero, null);
          var limits = new Native.ExtendedLimits(); limits.basic.flags = 0x2000;
          Require(job != IntPtr.Zero && Native.SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)), "job");
          new Thread(Pump) { IsBackground = true }.Start();
          new Thread(ControlLoop) { IsBackground = true }.Start();
          Native.FreeConsole();
          Require(Native.AllocConsole(), "console");
          Native.ShowWindow(Native.GetConsoleWindow(), 0);
          handler = delegate(uint kind) { return true; };
          Require(Native.SetConsoleCtrlHandler(handler, true), "console-handler");
          isolatedConsole = true;
          using (var input = Native.ConsoleInput()) {
            uint mode; Require(Native.GetConsoleMode(input.DangerousGetHandle(), out mode), "console-stdin");
            IntPtr outRead, outWrite, errRead, errWrite;
            var security = new Native.Security(); security.length = Marshal.SizeOf(security); security.inherit = true;
            Require(Native.CreatePipe(out outRead, out outWrite, ref security, 65536), "stdout-pipe");
            using (var outR = new SafeFileHandle(outRead, true)) using (var outW = new SafeFileHandle(outWrite, true)) {
              Require(Native.SetHandleInformation(outRead, 1, 0), "stdout-inherit");
              Require(Native.CreatePipe(out errRead, out errWrite, ref security, 65536), "stderr-pipe");
              using (var errR = new SafeFileHandle(errRead, true)) using (var errW = new SafeFileHandle(errWrite, true)) {
                Require(Native.SetHandleInformation(errRead, 1, 0), "stderr-inherit");
                Native.ProcessInfo child;
                lock (Gate) {
                  Require(ending == 0 && Utc() < expires, "cancelled-before-launch");
                  child = Native.Launch(image, command, cwd, input.DangerousGetHandle(), outWrite, errWrite, job);
                  Require(Native.ResumeThread(child.thread) == 1, "resume");
                  launched = true;
                }
                using (var process = new SafeFileHandle(child.process, true)) using (var thread = new SafeFileHandle(child.thread, true)) {
                  outW.Close(); errW.Close();
                  Enqueue(1, Utf8.GetBytes(Json().Serialize(new { version = 1, nonce = nonce, kind = "ready", helperPid = Process.GetCurrentProcess().Id,
                    helperBirth = Native.Birth(Native.GetCurrentProcess()), cliPid = child.pid, cliBirth = Native.Birth(child.process) })));
                  var stdout = Reader(outR, 2); var stderr = Reader(errR, 3);
                  Require(Native.WaitForSingleObject(child.process, 0xffffffff) == 0, "child-wait");
                  uint code; Require(Native.GetExitCodeProcess(child.process, out code), "child-exit");
                  var drain = Stopwatch.StartNew();
                  Require(stdout.Join(1000) && stderr.Join(Math.Max(0, 1000 - (int)drain.ElapsedMilliseconds)), "output-drain");
                  lock (Gate) {
                    Require(ending == 0 && Utc() < expires, "cancelled-or-expired");
                    finished = true;
                  }
                  Complete(unchecked((int)code));
                }
              }
            }
          }
        }
        return 0;
      } catch (Exception error) { Stop(error is InvalidOperationException ? error.Message : "native-failure"); new ManualResetEvent(false).WaitOne(4500); return 31; }
    }

    static Thread Reader(SafeFileHandle handle, byte kind) {
      var thread = new Thread(delegate() {
        try {
          using (var stream = new FileStream(handle, FileAccess.Read, 65536, false)) {
            var bytes = new byte[65536]; int count;
            while ((count = stream.Read(bytes, 0, bytes.Length)) > 0) {
              Require(Interlocked.Add(ref total, count) <= 1048576 && Utc() < expires, "output-limit");
              var body = new byte[count]; Buffer.BlockCopy(bytes, 0, body, 0, count); Enqueue(kind, body);
            }
          }
        } catch { Stop(); }
      }) { IsBackground = true };
      thread.Start(); return thread;
    }

    static void Watch() {
      while (true) {
        Thread.Sleep(20);
        if (Clock.ElapsedMilliseconds > 300000 || (expires != 0 && Utc() >= expires) ||
          (owner != IntPtr.Zero && Native.WaitForSingleObject(owner, 0) != 258) ||
          (!launched && Clock.ElapsedMilliseconds > 10000)) { Stop(); return; }
      }
    }

    static void Stop(string reason = "stopped") {
      // The hard brake runs independently of the launch and output locks.
      if (Interlocked.CompareExchange(ref braking, 1, 0) != 0) return;
      stopReason = reason;
      new Thread(delegate() { new ManualResetEvent(false).WaitOne(4000); Environment.Exit(31); }) { IsBackground = true }.Start();
      lock (Gate) {
        ending = 1;
        // Before AllocConsole, Ctrl-C can reach the inherited caller console (native control, 2026-10-31).
        if (isolatedConsole) Native.GenerateConsoleCtrlEvent(0, 0);
      }
      new Thread(delegate() {
        new ManualResetEvent(false).WaitOne(1000);
        Complete(null);
      }) { IsBackground = true }.Start();
    }

    static void Complete(int? code) {
      if (Interlocked.CompareExchange(ref completing, 1, 0) != 0) return;
      new Thread(delegate() { new ManualResetEvent(false).WaitOne(3000); Environment.Exit(31); }) { IsBackground = true }.Start();
      try {
        if (job == IntPtr.Zero) {
          Write(5, Utf8.GetBytes(Json().Serialize(new { version = 1, nonce = nonce, kind = "cleaned", reason = stopReason })));
          Environment.Exit(31);
        }
        // TerminateJobObject is asynchronous; only a zero-member query acknowledges cleanup.
        Require(job != IntPtr.Zero && Native.TerminateJobObject(job, 31), "terminate-job");
        var deadline = Stopwatch.StartNew();
        using (var pause = new ManualResetEvent(false)) {
          while (true) {
            Native.Accounting accounting;
            Require(Native.QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Native.Accounting)), IntPtr.Zero), "job-accounting");
            if (accounting.active == 0) break;
            Require(deadline.ElapsedMilliseconds < 2000, "cleanup-expired");
            pause.WaitOne(10);
          }
        }
        if (code.HasValue)
          Enqueue(4, Utf8.GetBytes(Json().Serialize(new { version = 1, nonce = nonce, kind = "exited", code = code.Value, cleaned = true })));
        else
          Enqueue(5, Utf8.GetBytes(Json().Serialize(new { version = 1, nonce = nonce, kind = "cleaned", reason = stopReason })));
        Require(Drained.WaitOne(500), "transport-drain");
        Native.CloseHandle(job);
        Environment.Exit(code.HasValue ? 0 : 31);
      } catch { Environment.Exit(31); }
    }

    static void ControlLoop() {
      try {
        var frame = Control();
        Require(frame.Count == 3 && Number(frame, "version") == 1 && Text(frame, "kind") == "cancel" && Text(frame, "nonce") == nonce, "cancel");
      } catch { }
      // A control frame, malformed data or EOF all latch before the launch gate.
      lock (Gate) { if (!finished) Stop(); }
    }

    static Dictionary<string, object> Control() {
      var header = Read(5); Require(header[0] == 1, "frame-kind");
      uint size = BitConverter.ToUInt32(header, 1); Require(size > 0 && size <= 98304, "frame-limit");
      var result = Json().DeserializeObject(Utf8.GetString(Read((int)size))) as Dictionary<string, object>;
      Require(result != null, "control"); return result;
    }
    static byte[] Read(int size) {
      var bytes = new byte[size]; int at = 0;
      while (at < size) { int count = Input.Read(bytes, at, size - at); Require(count > 0, "eof"); at += count; }
      return bytes;
    }
    static void Enqueue(byte kind, byte[] body) {
      lock (QueueGate) {
        Require(queued + body.Length + 5 <= 262144, "queue-limit");
        var frame = new byte[body.Length + 5]; frame[0] = kind; Buffer.BlockCopy(BitConverter.GetBytes(body.Length), 0, frame, 1, 4);
        Buffer.BlockCopy(body, 0, frame, 5, body.Length); Queue.Enqueue(frame); queued += frame.Length; Drained.Reset(); Queued.Set();
      }
    }
    static void Pump() {
      try {
        while (true) {
          Queued.WaitOne();
          while (true) {
            byte[] frame;
            lock (QueueGate) { if (Queue.Count == 0) { Drained.Set(); break; } frame = Queue.Dequeue(); }
            Output.Write(frame, 0, frame.Length); Output.Flush();
            lock (QueueGate) { queued -= frame.Length; }
          }
        }
      } catch { Stop(); }
    }
    static void Write(byte kind, byte[] body) { Output.WriteByte(kind); var length = BitConverter.GetBytes(body.Length); Output.Write(length, 0, 4); Output.Write(body, 0, body.Length); Output.Flush(); }
    static long Utc() { return (DateTime.UtcNow.Ticks - 621355968000000000L) / 10000; }
    static string Text(Dictionary<string, object> value, string key) { object field; Require(value.TryGetValue(key, out field) && field is string, "field"); return (string)field; }
    static long Number(Dictionary<string, object> value, string key) { object field; Require(value.TryGetValue(key, out field) && (field is int || field is long), "field"); return Convert.ToInt64(field); }
    static bool Absolute(string path) { return path.Length <= 32766 && path.IndexOf('\0') < 0 && path.Length >= 3 && ((char.IsLetter(path[0]) && path[1] == ':' && (path[2] == '\\' || path[2] == '/')) || path.StartsWith(@"\\") || path.StartsWith("//")); }
    internal static void Require(bool value, string reason) { if (!value) throw new InvalidOperationException(reason); }
    static string Quote(string value) {
      var result = new StringBuilder("\""); int slashes = 0;
      foreach (char c in value) { if (c == '\\') { slashes++; continue; } result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); result.Append(c); slashes = 0; }
      return result.Append('\\', slashes * 2).Append('"').ToString();
    }
  }

  internal sealed class Owner : IDisposable {
    internal readonly IntPtr Handle;
    internal readonly string Birth;
    internal Owner(int pid, string expected) {
      Handle = Native.OpenProcess(0x1000 | 0x100000, false, pid);
      try {
        Program.Require(Handle != IntPtr.Zero && Native.WaitForSingleObject(Handle, 0) == 258, "owner");
        Birth = Native.Birth(Handle);
        Program.Require(expected == null || expected == Birth, "owner-birth");
        IntPtr token; Program.Require(Native.OpenProcessToken(Handle, 8, out token), "owner-token");
        try { using (var identity = new WindowsIdentity(token)) using (var self = WindowsIdentity.GetCurrent()) Program.Require(identity.User.Value == self.User.Value, "owner-sid"); }
        finally { Native.CloseHandle(token); }
      } catch { Dispose(); throw; }
    }
    public void Dispose() { if (Handle != IntPtr.Zero) Native.CloseHandle(Handle); }
  }

  internal static class Native {
    [StructLayout(LayoutKind.Sequential)] internal struct BasicLimits { public long t1, t2; public uint flags; public UIntPtr min, max; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
    [StructLayout(LayoutKind.Sequential)] internal struct IoCounters { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)] internal struct ExtendedLimits { public BasicLimits basic; public IoCounters io; public UIntPtr pm, jm, pp, pj; }
    [StructLayout(LayoutKind.Sequential)] internal struct Accounting { public long user, kernel, periodUser, periodKernel; public uint faults, total, active, terminated; }
    [StructLayout(LayoutKind.Sequential)] internal struct Security { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup { public int size; public string reserved, desktop, title; public uint x,y,xs,ys,xc,yc,fill,flags; public short show,reserved2; public IntPtr reserved3,input,output,error; }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] internal struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] internal static extern bool AllocConsole();
    [DllImport("kernel32.dll")] internal static extern bool FreeConsole();
    [DllImport("kernel32.dll")] internal static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr window, int show);
    internal delegate bool Handler(uint kind);
    [DllImport("kernel32.dll")] internal static extern bool SetConsoleCtrlHandler(Handler handler, bool add);
    [DllImport("kernel32.dll")] internal static extern bool GenerateConsoleCtrlEvent(uint kind, uint group);
    [DllImport("kernel32.dll")] internal static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFile(string name, uint access, uint share, ref Security security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll")] internal static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, uint size);
    [DllImport("kernel32.dll")] internal static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll")] internal static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] internal static extern bool GetProcessTimes(IntPtr process, out long birth, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")] internal static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")] internal static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll")] internal static extern bool OpenProcessToken(IntPtr handle, uint access, out IntPtr token);
    [DllImport("kernel32.dll")] static extern void GetNativeSystemInfo(byte[] info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string image, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
    internal static string Birth(IntPtr handle) { long b,e,k,u; Program.Require(GetProcessTimes(handle, out b, out e, out k, out u), "birth"); return b.ToString(System.Globalization.CultureInfo.InvariantCulture); }
    internal static bool Target() {
      var info = new byte[48]; GetNativeSystemInfo(info);
      if (!Environment.Is64BitProcess || BitConverter.ToUInt16(info, 0) != 9 || Environment.OSVersion.Version.Major < 10) return false;
      using (var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full")) { object release = key == null ? null : key.GetValue("Release"); return release is int && (int)release >= 533320; }
    }
    internal static SafeFileHandle ConsoleInput() { var security = new Security { length = Marshal.SizeOf(typeof(Security)), inherit = true }; var handle = CreateFile("CONIN$", 0xc0000000, 3, ref security, 3, 0, IntPtr.Zero); Program.Require(!handle.IsInvalid, "console-input"); return handle; }
    internal static ProcessInfo Launch(string image, StringBuilder command, string cwd, IntPtr input, IntPtr output, IntPtr error, IntPtr job) {
      IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
      IntPtr attributes = Marshal.AllocHGlobal(size), handles = Marshal.AllocHGlobal(IntPtr.Size * 3), jobs = Marshal.AllocHGlobal(IntPtr.Size);
      bool initialized = false;
      try {
        Program.Require(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "attribute-list"); initialized = true;
        Marshal.WriteIntPtr(handles, 0, input); Marshal.WriteIntPtr(handles, IntPtr.Size, output); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, error);
        Program.Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "handle-list");
        // Windows 10 job-list creation contains the suspended child even if the monitor dies before resume.
        Marshal.WriteIntPtr(jobs, job);
        Program.Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000d), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "job-list");
        var startup = new StartupEx(); startup.startup.size = Marshal.SizeOf(startup); startup.attributes = attributes;
        startup.startup.flags = 0x100 | 1; startup.startup.show = 0; startup.startup.input = input; startup.startup.output = output; startup.startup.error = error;
        ProcessInfo process; Program.Require(CreateProcess(image, command, IntPtr.Zero, IntPtr.Zero, true, 0x80000 | 4, IntPtr.Zero, cwd, ref startup, out process), "create-process"); return process;
      } finally { if (initialized) DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); Marshal.FreeHGlobal(handles); Marshal.FreeHGlobal(jobs); }
    }
  }
}
