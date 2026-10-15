$ErrorActionPreference='Stop'
$helper=Join-Path $PSScriptRoot '../../native/accessibility-desktop.ps1'
$source=Get-Content -LiteralPath $helper -Raw
$match=[regex]::Match($source,"Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@")
if(!$match.Success){throw 'Native class missing.'}
$native=$match.Groups[1].Value
$native=$native.Replace('public static class AccessibilityNative {','public static class AccessibilityNative { public static int FakeHeldKey=-1, FakeMoves, FakeSends; public static bool FakeMoveAccepted=true,FakeSendAccepted=true; public static IntPtr FakeForeground=(IntPtr)10,FakeHitBefore=(IntPtr)20,FakeHitAfter=(IntPtr)20;')
$replacements=@{
 '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'='public static IntPtr GetForegroundWindow(){return FakeForeground;}'
 '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);'='public static short GetAsyncKeyState(int key){return key==FakeHeldKey ? unchecked((short)0x8000) : (short)0;}'
 '[DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);'='static bool SetCursorPos(int x,int y){FakeMoves++;return FakeMoveAccepted;}'
 '[DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);'='static IntPtr WindowFromPoint(Point point){return FakeMoves==0 ? FakeHitBefore : FakeHitAfter;}'
 '[DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);'='static IntPtr GetAncestor(IntPtr window,uint flags){return window;}'
 '[DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] input, int size);'='static uint SendInput(uint count, Input[] input, int size){FakeSends++;return FakeSendAccepted ? count : 0;}'
}
foreach($old in $replacements.Keys){if(!$native.Contains($old)){throw 'Native test seam changed.'};$native=$native.Replace($old,$replacements[$old])}
# Unused declarations remain compiled, but every native method reached by
# PointInput is replaced above. This test cannot deliver pointer input.
Add-Type -TypeDefinition $native
$results=New-Object 'System.Collections.Generic.List[object]'
function Run-Case([string]$name,[scriptblock]$setup,[bool]$scroll,[string]$expected,[int]$moves,[int]$sends){
 [AccessibilityNative]::FakeHeldKey=-1;[AccessibilityNative]::FakeMoves=0;[AccessibilityNative]::FakeSends=0
 [AccessibilityNative]::FakeMoveAccepted=$true;[AccessibilityNative]::FakeSendAccepted=$true
 [AccessibilityNative]::FakeForeground=[IntPtr]10;[AccessibilityNative]::FakeHitBefore=[IntPtr]20;[AccessibilityNative]::FakeHitAfter=[IntPtr]20
 & $setup
 $cause=$null
 try{[AccessibilityNative]::PointInput(5,5,[IntPtr]20,$scroll,120)}catch{$cause=$_.Exception.InnerException}
 if($expected){if(!$cause -or $cause.GetType().FullName -cne 'AccessibilityRefusal' -or !$cause.Message.StartsWith('['+$expected+']')){throw "Wrong refusal: $name"}}elseif($cause){throw "Unexpected refusal: $name"}
 if([AccessibilityNative]::FakeMoves -ne $moves -or [AccessibilityNative]::FakeSends -ne $sends){throw "Unexpected input attempts: $name"}
 $results.Add(@{name=$name;passed=$true})
}
Run-Case 'held modifier prevents movement and input' {[AccessibilityNative]::FakeHeldKey=17} $false 'INPUT_HELD' 0 0
Run-Case 'occluded target prevents movement and input' {[AccessibilityNative]::FakeHitBefore=[IntPtr]30} $false 'POINTER_TARGET_OBSCURED' 0 0
Run-Case 'scroll requires foreground before movement' {} $true 'SCROLL_FOREGROUND_CHANGED' 0 0
Run-Case 'movement failure prevents click delivery' {[AccessibilityNative]::FakeMoveAccepted=$false} $false 'POINTER_MOVE_FAILED' 1 0
Run-Case 'point becomes obscured after movement: no click' {[AccessibilityNative]::FakeHitAfter=[IntPtr]30} $false 'POINTER_TARGET_CHANGED' 1 0
Run-Case 'uncertain click reports uncertainty after safe release attempt' {[AccessibilityNative]::FakeSendAccepted=$false} $false 'POINTER_DELIVERY_UNCERTAIN' 1 2
Run-Case 'unobscured click preserves natural activation behavior' {} $false '' 1 1
@{passed=$results.Count;total=$results.Count;uiInvoked=$false;results=@($results.ToArray())}|ConvertTo-Json -Depth 6
