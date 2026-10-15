$ErrorActionPreference = 'Stop'
# All window, provider, and focus operations below are inert test doubles.
# This harness loads no UI Automation assembly and invokes no Win32 APIs.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public static class FocusReviewNative {
  public static IntPtr Foreground;
  public static bool RaiseSuccess;
  public static bool RaiseRace;
  public static bool DirectSuccess;
  public static bool DirectRace;
  public static bool Iconic;
  public static List<string> Events = new List<string>();
  public static IntPtr GetForegroundWindow() { return Foreground; }
  public static bool IsIconic(IntPtr h) { return Iconic; }
  public static bool ShowWindow(IntPtr h, int mode) { Events.Add("restore"); return true; }
  public static bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags) {
    if (h != (IntPtr)20 || after != IntPtr.Zero || x != 0 || y != 0 || width != 0 || height != 0 || flags != 0x13) throw new Exception("Invalid raise request");
    Events.Add("raise");
    if (RaiseRace) Foreground=(IntPtr)30;
    return RaiseSuccess;
  }
  public static bool SetForegroundWindow(IntPtr h) { Events.Add("direct"); if(DirectSuccess) Foreground=h; if(DirectRace) Foreground=(IntPtr)30; return DirectSuccess; }
}
public sealed class FocusReviewElement {
  public int[] RuntimeId;
  public int[] GetRuntimeId() { return RuntimeId; }
}
public static class FocusReviewAutomation {
  public static FocusReviewElement FocusedElement;
}
'@
$parseErrors = $null
$parseTokens = $null
$candidatePath = Join-Path $PSScriptRoot '../../native/accessibility-desktop.ps1'
$candidateAST = [System.Management.Automation.Language.Parser]::ParseFile($candidatePath, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'Full candidate did not parse.' }
$focusAST = $candidateAST.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Focus-Target' }, $true)
if (!$focusAST) { throw 'Focus function absent.' }
function Refuse([string]$reason) { throw $reason }
$source = $focusAST.Extent.Text
$source = $source.Replace('[AccessibilityNative]', '[FocusReviewNative]').Replace('[System.Windows.Automation.AutomationElement]', '[FocusReviewAutomation]')
Invoke-Expression $source
function Assert-Window {
  [FocusReviewNative]::Events.Add('assert')
  $script:assertCount++
  if ($script:failAssertAt -eq $script:assertCount) { throw 'Window changed.' }
  if ($script:raceAssertAt -eq $script:assertCount) { [FocusReviewNative]::Foreground = [IntPtr]30 }
  if ($script:targetAssertAt -eq $script:assertCount) { [FocusReviewNative]::Foreground = [IntPtr]20 }
}
function New-Root([string]$mode) {
  $root = [pscustomobject]@{ Mode = $mode }
  $root | Add-Member -MemberType ScriptMethod -Name SetFocus -Value {
    [FocusReviewNative]::Events.Add('root-focus')
    if ($this.Mode -eq 'throw') { throw 'Provider declined focus.' }
    if ($this.Mode -eq 'success') { [FocusReviewNative]::Foreground = [IntPtr]20 }
  }
  return $root
}
function New-Field([string]$mode) {
  $field = [pscustomobject]@{ Mode = $mode }
  $field | Add-Member -MemberType ScriptMethod -Name SetFocus -Value {
    [FocusReviewNative]::Events.Add('field-focus')
    if ($this.Mode -eq 'race') { [FocusReviewNative]::Foreground = [IntPtr]30 }
    $focused = New-Object FocusReviewElement
    $focused.RuntimeId = if ($this.Mode -eq 'wrong-control') { @(8,9) } else { @(1,2) }
    [FocusReviewAutomation]::FocusedElement = $focused
  }
  return $field
}
function Reset-Case {
  [FocusReviewNative]::Foreground = [IntPtr]10
  [FocusReviewNative]::RaiseSuccess = $true
  [FocusReviewNative]::RaiseRace = $false
  [FocusReviewNative]::DirectSuccess = $false
  [FocusReviewNative]::DirectRace = $false
  [FocusReviewNative]::Iconic = $false
  [FocusReviewNative]::Events.Clear()
  $script:assertCount = 0
  $script:failAssertAt = -1
  $script:raceAssertAt = -1
  $script:targetAssertAt = -1
  $script:request = @{ window=@{ handle='20' }; control=@{runtimeId='1.2'} }
  $script:windowRoot = New-Root 'success'
}
$results = New-Object System.Collections.Generic.List[object]
function Run-Case([string]$name, [scriptblock]$setup, [bool]$mustFail, [string[]]$absent, [string[]]$present, [string]$expectedCode) {
  Reset-Case
  & $setup
  $caught = $false
  try { Focus-Target $script:field; [FocusReviewNative]::Events.Add('send') } catch { $caught = $true }
  if ($caught -ne $mustFail) { throw "Unexpected outcome: $name" }
  foreach ($event in $absent) { if ([FocusReviewNative]::Events.Contains($event)) { throw "Forbidden $event in $name" } }
  foreach ($event in $present) { if (![FocusReviewNative]::Events.Contains($event)) { throw "Missing $event in $name" } }
  $results.Add(@{name=$name;  passed=$true; events=@([FocusReviewNative]::Events.ToArray())})
}
Run-Case 'already foreground avoids activation' { [FocusReviewNative]::Foreground=[IntPtr]20; $script:field=New-Field 'success' } $false @('raise','direct','root-focus') @('field-focus','send')
Run-Case 'native activation permits exact field focus' { [FocusReviewNative]::DirectSuccess=$true; $script:field=New-Field 'success' } $false @('root-focus') @('raise','direct','field-focus','send')
Run-Case 'native refusal never uses unfocusable root or field' { $script:field=New-Field 'success' } $true @('root-focus','field-focus','send') @('raise','direct')
Run-Case 'raise refusal sends no input' { [FocusReviewNative]::RaiseSuccess=$false; $script:field=New-Field 'success' } $true @('direct','root-focus','field-focus','send') @('raise')
Run-Case 'foreground race during identity check stops activation' { $script:raceAssertAt=2; $script:field=New-Field 'success' } $true @('raise','direct','root-focus','field-focus','send') @()
Run-Case 'foreground race during field focus sends no input' { [FocusReviewNative]::DirectSuccess=$true; $script:field=New-Field 'race' } $true @('send') @('field-focus')
Run-Case 'wrong field focus sends no input' { [FocusReviewNative]::DirectSuccess=$true; $script:field=New-Field 'wrong-control' } $true @('send') @('field-focus')
Run-Case 'window-only activation never invokes any UIA focus' { [FocusReviewNative]::DirectSuccess=$true; $script:field=$null } $false @('root-focus','field-focus') @('raise','direct','send')
Run-Case 'target becomes foreground during validation: no redundant activation' { $script:targetAssertAt=2; $script:field=New-Field 'success' } $false @('raise','direct','root-focus') @('field-focus','send')
@{passed=$results.Count;total=$results.Count;uiInvoked=$false;fullCandidateParsed=$true;results=@($results.ToArray())}|ConvertTo-Json -Depth 7
