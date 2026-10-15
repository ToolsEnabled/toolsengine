$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# This helper accepts paths, never capability contents or executable text.
# It creates only missing directories; existing security descriptors are read only.
function Refuse-Security([string]$reason) { throw [InvalidOperationException]::new($reason) }
function Plain-DirectoryPath([string]$value) {
  if (!$value -or $value -notmatch '^[A-Za-z]:\\' -or $value.Substring(2).Contains(':')) { Refuse-Security 'Use an absolute local drive path.' }
  $full = [IO.Path]::GetFullPath($value)
  $current = [IO.Path]::GetPathRoot($full)
  foreach ($part in $full.Substring($current.Length).Split('\', [StringSplitOptions]::RemoveEmptyEntries)) {
    if ($part -match '[<>"|?*\x00-\x1f]' -or $part -match '[. ]$' -or $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { Refuse-Security 'The directory name is not supported on Windows.' }
    $current = [IO.Path]::Combine($current, $part)
    if ([IO.File]::Exists($current)) { Refuse-Security 'A directory path names a file.' }
    if ([IO.Directory]::Exists($current)) {
      if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse-Security 'Directory paths must not traverse reparse points or junctions.' }
    }
  }
  return $full
}
function Read-DirectorySecurity([string]$directory) {
  if (![IO.Directory]::Exists($directory)) { Refuse-Security 'The directory does not exist.' }
  $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
  $acl = [IO.Directory]::GetAccessControl($directory, $sections)
  $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $raw.DiscretionaryAcl) { Refuse-Security 'A null DACL is not supported.' }
  $trusted = @($script:userSid.Value, 'S-1-5-18', 'S-1-5-32-544')
  $private = $true
  $writeRestricted = $true
  $writeRights = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $trusted -notcontains $rule.IdentityReference.Value) {
      if ($rule.FileSystemRights -ne 0) { $private = $false }
      if (($rule.FileSystemRights -band $writeRights) -ne 0) { $writeRestricted = $false }
    }
  }
  return @{ ownerSid=$ownerSid; userSid=$script:userSid.Value; ownerTrusted=($trusted -contains $ownerSid); ownedByUser=($ownerSid -eq $script:userSid.Value); private=$private; writeRestricted=$writeRestricted; protected=$acl.AreAccessRulesProtected }
}
function New-PrivateDirectory([string]$directory) {
  if ([IO.Directory]::Exists($directory)) { return }
  $parent = [IO.Path]::GetDirectoryName($directory)
  if (!$parent -or $parent -eq $directory) { Refuse-Security 'A directory parent is required.' }
  if (![IO.Directory]::Exists($parent)) { New-PrivateDirectory $parent }
  $parentSecurity = Read-DirectorySecurity $parent
  if (!$parentSecurity.ownerTrusted -or !$parentSecurity.writeRestricted) { Refuse-Security 'The parent can be changed by another account. Choose a private install location.' }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($script:userSid)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($sidValue in @($script:userSid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $sid = New-Object Security.Principal.SecurityIdentifier($sidValue)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $null = $acl.AddAccessRule($rule)
  }
  # Windows PowerShell 5.1/.NET Framework creates the directory with its DACL,
  # before any program, workspace or installer-record bytes are written.
  $null = [IO.Directory]::CreateDirectory($directory, $acl)
}
try {
  $inputText = [Console]::In.ReadToEnd()
  if ($inputText.Length -gt 32768) { Refuse-Security 'The path request is too large.' }
  $request = $inputText | ConvertFrom-Json
  if ($request.operation -cnotin @('inspect','create') -or $request.path -isnot [string] -or @($request.PSObject.Properties.Name | Where-Object { $_ -cnotin @('operation','path') }).Count) { Refuse-Security 'The path request is invalid.' }
  $script:userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $directory = Plain-DirectoryPath $request.path
  if ($request.operation -ceq 'create') { New-PrivateDirectory $directory }
  $null = Plain-DirectoryPath $directory
  $result = Read-DirectorySecurity $directory
  if ($request.operation -ceq 'create' -and (!$result.ownerTrusted -or !$result.writeRestricted)) { Refuse-Security 'The install directory can be changed by another account.' }
  $result.ok = $true
  [Console]::WriteLine(($result | ConvertTo-Json -Compress))
} catch {
  # Exception/provider messages can contain paths or environment data. Only our
  # own bounded reasons may be displayed by the Node installer.
  $reason = 'Windows directory security could not be verified.'
  if ($_.Exception -is [InvalidOperationException] -and $_.Exception.Message.Length -le 160) { $reason = $_.Exception.Message }
  [Console]::WriteLine((@{ok=$false;code='WINDOWS_DIRECTORY_SECURITY';reason=$reason} | ConvertTo-Json -Compress))
  exit 1
}
