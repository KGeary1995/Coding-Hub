# Prints "<pid> <process name>" of the top-level window that owns screen point (X, Y): what a screen capture at that
# point actually shows. Used by gpu-crash-smoke.cjs to tell Trace's own window from another one in front of it.
param([int]$X, [int]$Y)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TraceWindowAt {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
"@
$point = New-Object TraceWindowAt+Point
$point.X = $X; $point.Y = $Y
$window = [TraceWindowAt]::GetAncestor([TraceWindowAt]::WindowFromPoint($point), 2)
$owner = [uint32]0
[void][TraceWindowAt]::GetWindowThreadProcessId($window, [ref]$owner)
$name = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName
"$owner $name"
