$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
public sealed class ComboProbeType { public string ProgrammaticName="ControlType.ComboBox"; }
public sealed class ComboProbeInfo {
 public bool IsPassword,IsOffscreen; public bool IsEnabled=true,IsKeyboardFocusable=true; public string Name="Synthetic recipients"; public ComboProbeInfo LabeledBy; public ComboProbeType ControlType=new ComboProbeType();
}
public sealed class ComboProbeValueInfo { public bool IsReadOnly; public string Value="synthetic@example.test"; }
public sealed class ComboProbeValue { public ComboProbeValueInfo Current=new ComboProbeValueInfo(); }
public sealed class ComboProbeNode {
 public ComboProbeInfo Current=new ComboProbeInfo(); public ComboProbeValue Value=new ComboProbeValue(); public bool HasValue=true; public int ValueQueries;
 public int[] GetRuntimeId(){return new int[]{1,2};}
 public bool TryGetCurrentPattern(string pattern,out object value){value=null;if(pattern=="ValuePattern"){ValueQueries++;if(HasValue){value=Value;return true;}}return false;}
}
'@
$candidatePath=Join-Path $PSScriptRoot '../../native/accessibility-desktop.ps1'
$parseErrors=$null;$tokens=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($candidatePath,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'Full candidate did not parse.'}
$fn=$ast.Find({param($node)$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Describe-Control'},$true)
$body=$fn.Extent.Text
foreach($name in @('InvokePattern','SelectionItemPattern','TogglePattern','ExpandCollapsePattern','ScrollPattern','ValuePattern','TextPattern')){$body=$body.Replace("[System.Windows.Automation.$name]::Pattern","'$name'")}
function Get-ProtectedTerm([string]$text,[bool]$allowSignIn) { return @{term='credential'} }
Invoke-Expression $body
$blockedLabels='(?i)password|credential|secret|sign.?in|log.?in'
$results=New-Object 'System.Collections.Generic.List[object]'
function Reset-Case{$script:request=@{command='inspect';includeText=$true};$script:textBudget=12000;$script:excludedCount=0;$script:observedTypes=@()}
Reset-Case;$node=New-Object ComboProbeNode;$row=Describe-Control $node
if($row.label -cne 'Synthetic recipients' -or $row.textMode -cne 'replace' -or 'type' -notin $row.actions -or $row.text -cne 'synthetic@example.test'){throw 'Writable combo not described correctly.'}
$results.Add(@{name='writable combo keeps name and advertises replace';passed=$true})
Reset-Case;$node=New-Object ComboProbeNode;$node.Value.Current.IsReadOnly=$true;$row=Describe-Control $node
if($row){throw 'Read-only combo advertised writable or inspected text.'}
$results.Add(@{name='read-only combo has no text capability';passed=$true})
Reset-Case;$node=New-Object ComboProbeNode;$node.HasValue=$false;$row=Describe-Control $node
if($row){throw 'Combo without ValuePattern got insert fallback.'}
$results.Add(@{name='no ValuePattern means no blind insert fallback';passed=$true})
foreach($guard in @('IsPassword','IsOffscreen','IsEnabled','ProtectedName')){
 Reset-Case;$node=New-Object ComboProbeNode
 if($guard -eq 'IsEnabled'){$node.Current.IsEnabled=$false}elseif($guard -eq 'ProtectedName'){$node.Current.Name='credential'}else{$node.Current.$guard=$true}
 $row=Describe-Control $node;if($row -or $node.ValueQueries -ne 0){throw 'Protected combo touched ValuePattern.'}
}
$results.Add(@{name='password hidden disabled protected-name guards precede ValuePattern';passed=$true})
Reset-Case;$node=New-Object ComboProbeNode;$node.Value.Current.Value='x'*2500;$row=Describe-Control $node
if($row.text.Length -ne 2000 -or !$row.textTruncated -or $script:textBudget -ne 10000){throw 'Combo field text bound failed.'}
$results.Add(@{name='combo text bounded to field and total budget';passed=$true})
Reset-Case;$script:textBudget=17;$node=New-Object ComboProbeNode;$row=Describe-Control $node
if($row.text.Length -ne 17 -or $script:textBudget -ne 0){throw 'Remaining total text budget ignored.'}
Reset-Case;$script:request.includeText=$false;$node=New-Object ComboProbeNode;$row=Describe-Control $node
if($row.ContainsKey('text')){throw 'Text exposed without requested inspection.'}
$results.Add(@{name='total budget and includeText opt-in preserved';passed=$true})
@{passed=$results.Count;total=$results.Count;fullCandidateParsed=$true;uiInvoked=$false;candidateSHA256=(Get-FileHash -Algorithm SHA256 -LiteralPath $candidatePath).Hash.ToLowerInvariant();results=@($results.ToArray())}|ConvertTo-Json -Depth 6
