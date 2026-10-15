param([switch]$RawDescriptors)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$tree = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../../installer/windows-security.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Installer security helper did not parse.' }
foreach ($name in @('Refuse-Security','Assert-PlainLocalInput','Assert-AncestorSecurity','Assess-RawSecurityDescriptor')) {
  $function = $tree.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true)
  if (!$function) { throw ('Required function missing: '+$name) }
  Invoke-Expression $function.Extent.Text
}
$passed = 0
function Check([bool]$value) { if (!$value) { throw 'Security expectation failed.' }; $script:passed++ }
foreach ($owner in @($false,$true)) { foreach ($control in @($false,$true)) {
  $refused = $false
  try { Assert-AncestorSecurity @{ownerTrusted=$owner;ancestorControlRestricted=$control} } catch { $refused = $true }
  Check ($refused -eq (!$owner -or !$control))
} }
foreach ($path in @('C:relative','\relative','\\server\share','C:\safe\name.','C:\safe\name ','C:\safe\..\other','C:\safe\file:stream','C:\safe\nul.txt')) {
  $refused=$false;try { Assert-PlainLocalInput $path } catch { $refused=$true };Check $refused
}
Assert-PlainLocalInput 'C:\safe\normal-name'
Check $true
if ($RawDescriptors) {
  $user = 'S-1-5-21-111-222-333-1001'
  function Descriptor([string]$extra) { return New-Object Security.AccessControl.RawSecurityDescriptor("O:${user}D:P(A;;FA;;;${user})${extra}") }
  $safe = Assess-RawSecurityDescriptor (Descriptor '') $user
  Check ($safe.private -and $safe.writeRestricted -and $safe.ancestorControlRestricted -and $safe.ownedByUser)
  # SDDL DC is object-specific bit 0x2, not file FILE_DELETE_CHILD (0x40).
  # Numeric file masks avoid borrowing directory-service abbreviations.
  Check ((Descriptor '(A;;DC;;;WD)').DiscretionaryAcl[1].AccessMask -eq 2)
  Check ((Descriptor '(A;;0x00000040;;;WD)').DiscretionaryAcl[1].AccessMask -eq 64)
  foreach ($right in @('SD','0x00000040','WD','WO','GA','GW','0x00000100','0x00000010')) {
    $unsafe = Assess-RawSecurityDescriptor (Descriptor "(A;;${right};;;WD)") $user
    Check (!$unsafe.writeRestricted -and !$unsafe.ancestorControlRestricted)
  }
  foreach ($right in @('0x00000001','0x00000002','0x00000004','0x00020000')) {
    $readOrSiblingCreate = Assess-RawSecurityDescriptor (Descriptor "(A;;${right};;;WD)") $user
    Check ($readOrSiblingCreate.ancestorControlRestricted)
  }
  $inheritedOnly = Assess-RawSecurityDescriptor (Descriptor '(A;OICIIO;GA;;;WD)') $user
  Check ($inheritedOnly.ancestorControlRestricted -and !$inheritedOnly.writeRestricted -and !$inheritedOnly.private)
  $foreignOwner = Descriptor ''
  $foreignOwner.Owner = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
  $foreign = Assess-RawSecurityDescriptor $foreignOwner $user
  $refused = $false
  try { Assert-AncestorSecurity $foreign } catch { $refused=$true }
  Check ($refused -and !$foreign.ownerTrusted)
  $serviceOwner = Descriptor ''
  $serviceOwner.Owner = New-Object Security.Principal.SecurityIdentifier('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $service = Assess-RawSecurityDescriptor $serviceOwner $user
  Check (!$service.ownerTrusted -and !$service.ownedByUser)
  $refused=$false;try { Assert-AncestorSecurity $service } catch { $refused=$true };Check (!$refused)
  $unsafeServiceOwner = Descriptor '(A;;0x00040000;;;WD)'
  $unsafeServiceOwner.Owner=$serviceOwner.Owner
  $refused=$false;try { Assert-AncestorSecurity (Assess-RawSecurityDescriptor $unsafeServiceOwner $user) } catch { $refused=$true };Check $refused
  $serviceOwner.Owner=New-Object Security.Principal.SecurityIdentifier('S-1-5-80-1-2-3-4-5')
  $refused=$false;try { Assert-AncestorSecurity (Assess-RawSecurityDescriptor $serviceOwner $user) } catch { $refused=$true };Check $refused
  foreach ($kind in @('callback','object','null')) {
    $raw = Descriptor ''
    if ($kind -eq 'null') { $raw.DiscretionaryAcl=$null }
    else {
      $everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
      if ($kind -eq 'callback') {
        $ace = New-Object Security.AccessControl.CommonAce([Security.AccessControl.AceFlags]::None,[Security.AccessControl.AceQualifier]::AccessAllowed,0x10000000,$everyone,$true,([byte[]]@(0,0,0,0)))
      } else {
        $ace = New-Object Security.AccessControl.ObjectAce([Security.AccessControl.AceFlags]::None,[Security.AccessControl.AceQualifier]::AccessAllowed,0x10000000,$everyone,[Security.AccessControl.ObjectAceFlags]::None,[Guid]::Empty,[Guid]::Empty,$false,$null)
      }
      $raw.DiscretionaryAcl.InsertAce(0,$ace)
    }
    $refused=$false
    try { $null=Assess-RawSecurityDescriptor $raw $user } catch { $refused=$true }
    Check $refused
  }
}
@{passed=$passed;total=$passed;uiInvoked=$false;rawDescriptors=[bool]$RawDescriptors}|ConvertTo-Json -Compress
