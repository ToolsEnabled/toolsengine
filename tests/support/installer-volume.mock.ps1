$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot '../../installer/windows-volume.cs')
$passed=0
foreach($type in @(0,1,2,3,4,5,6,7)){
  $refused=$false
  try{[ToolsEngineInstallerVolume]::RequireFixedDrive($type)}catch{$refused=$true}
  if($refused -ne ($type -ne 3)){throw 'Fixed drive gate mismatch'};$passed++
}
foreach($queried in @($false,$true)){foreach($name in @('NTFS','ntfs','ReFS','FAT32','')){
  $refused=$false
  try{[ToolsEngineInstallerVolume]::RequireNtfs($queried,$name)}catch{$refused=$true}
  if($refused -ne (!$queried -or $name -ine 'NTFS')){throw 'NTFS gate mismatch'};$passed++
}}
@{passed=$passed;total=18;nativeCalls=$false}|ConvertTo-Json -Compress
