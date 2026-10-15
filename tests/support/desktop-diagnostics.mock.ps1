$ErrorActionPreference = 'Stop'
# Parse and load only pure formatters. Never invoke the helper or any UI API.
$helperPath = Join-Path $PSScriptRoot '../../native/accessibility-desktop.ps1'
$tokens = $null; $errors = $null
$tree = [System.Management.Automation.Language.Parser]::ParseFile($helperPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Helper does not parse.' }
foreach ($name in @('New-SafeFocusFailure', 'New-SafeDesktopFailure')) {
  $function = $tree.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name}, $true)
  if (!$function) { throw 'Formatter is missing.' }
  Invoke-Expression $function.Extent.Text
}
$count = 0
function Check([bool]$ok) { if (!$ok) { throw 'Trusted diagnostic regression.' }; $script:count++ }
foreach ($code in @('WINDOW_OUTSIDE_LEFT_HALF','POINT_OUTSIDE_LEFT_HALF','WINDOW_DID_NOT_FIT_LEFT_HALF','WINDOW_GEOMETRY_CHANGED','WINDOW_MOVED_DURING_CAPTURE')) {
  $result = New-SafeDesktopFailure $code
  Check ($result.ok -eq $false -and $result.refusal -eq $true -and $result.code -ceq $code)
  Check ($result.error.StartsWith('['+$code+'] ') -and $result.error.Length -le 400)
}
foreach ($code in @($null,'','window_outside_left_half','WINDOW_OUTSIDE_LEFT_HALF untrusted','provider: private content')) {
  Check ($null -eq (New-SafeDesktopFailure $code))
  Check ($null -eq (New-SafeFocusFailure $code ([int]-1)))
}
foreach ($code in @('WINDOW_OUTSIDE_LEFT_HALF','POINT_OUTSIDE_LEFT_HALF')) {
  $result = New-SafeDesktopFailure $code
  Check ($result.error.IndexOf('desktop.act with kind focus') -lt $result.error.IndexOf('desktop.capture'))
  Check ($result.error.Contains('coordinates from the new image'))
}
foreach ($code in @('FOCUS_WINDOW_REVALIDATION','FOCUS_RAISE_FAILED','FOCUS_RESTORE','FOCUS_NATIVE_REQUEST','FOCUS_FOREGROUND_CHANGED','FOCUS_ROOT_UNAVAILABLE','FOCUS_UIA_ROOT_CALL','FOCUS_UIA_ROOT_NOT_FOREGROUND','FOCUS_UIA_FIELD_CALL','FOCUS_FIELD_MISMATCH')) {
  $result = New-SafeFocusFailure $code 'provider: private content'
  Check ($result.ok -eq $false -and $result.refusal -eq $true -and $result.code -ceq $code)
  Check (!$result.hresult -and !$result.error.Contains('private content') -and $result.error.Length -le 400)
  $numeric = New-SafeFocusFailure $code ([int]-2146233079)
  if ($code -cin @('FOCUS_UIA_ROOT_CALL','FOCUS_UIA_FIELD_CALL')) {
    Check ($numeric.hresult -ceq '0x80131509')
  } else { Check (!$numeric.hresult) }
}
foreach ($code in @('FOCUS_UIA_ROOT_CALL','FOCUS_UIA_ROOT_NOT_FOREGROUND')) {
  $result = New-SafeFocusFailure $code $null
  Check ($result.error.Contains('Capture the confirmed window again; if unobscured'))
  Check ($result.error.Contains('from the new image with desktop.pointer click, then verify focus'))
}
$wire = New-SafeDesktopFailure 'WINDOW_GEOMETRY_CHANGED' | ConvertTo-Json -Compress | ConvertFrom-Json
Check ($wire.refusal -eq $true -and $wire.code -ceq 'WINDOW_GEOMETRY_CHANGED')
@{passed=$count;total=$count;uiInvoked=$false} | ConvertTo-Json -Compress
