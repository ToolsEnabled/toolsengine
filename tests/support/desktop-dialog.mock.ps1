$ErrorActionPreference = 'Stop'
# Inert tree model only. No UI Automation assemblies or Win32 calls.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public sealed class DialogProbeInfo { public string ControlType="Pane"; public bool IsOffscreen; public bool IsPassword; public bool IsEnabled=true; }
public sealed class DialogProbeNode {
  public int Id; public DialogProbeInfo Current=new DialogProbeInfo(); public List<DialogProbeNode> Children=new List<DialogProbeNode>(); public DialogProbeNode Parent;
  public int[] GetRuntimeId(){return new int[]{Id};}
  public void Add(DialogProbeNode child){child.Parent=this;Children.Add(child);}
}
public sealed class DialogProbeWalker {
  public static DialogProbeWalker ControlViewWalker=new DialogProbeWalker(); public static int SiblingReads; public static bool RepeatSibling;
  public DialogProbeNode GetFirstChild(DialogProbeNode node){return node.Children.Count==0?null:node.Children[0];}
  public DialogProbeNode GetNextSibling(DialogProbeNode node){SiblingReads++;if(RepeatSibling)return node;if(node.Parent==null)return null;int i=node.Parent.Children.IndexOf(node)+1;return i>=node.Parent.Children.Count?null:node.Parent.Children[i];}
}
public static class DialogProbeControlType { public static string Window="Window"; }
'@
$candidatePath=Join-Path $PSScriptRoot '../../native/accessibility-desktop.ps1'
$parseErrors=$null; $tokens=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($candidatePath,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'Candidate parse failed.'}
$fn=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Read-Controls'},$true)
$body=$fn.Extent.Text.Replace('[System.Windows.Automation.TreeWalker]','[DialogProbeWalker]').Replace('[System.Windows.Automation.ControlType]','[DialogProbeControlType]')
function Refuse([string]$reason) { throw $reason }
Invoke-Expression $body
function New-Node([int]$Id,[string]$Type='Pane'){$n=New-Object DialogProbeNode;$n.Id=$Id;$n.Current.ControlType=$Type;return $n}
function Describe-Control($node){$script:order.Add($node.Id);if($node.Current.IsPassword -or !$node.Current.IsEnabled -or $node.Current.IsOffscreen){return $null};if($node.Current.ControlType -eq 'Edit'){return @{runtimeId=[string]$node.Id;label='Synthetic field';type='Edit';actions=@('type')}}}
function Reset-Case{$script:visitedCount=0;$script:order=New-Object 'System.Collections.Generic.List[int]';[DialogProbeWalker]::SiblingReads=0;[DialogProbeWalker]::RepeatSibling=$false}
$results=New-Object 'System.Collections.Generic.List[object]'
Reset-Case
$root=New-Node 1;$background=New-Node 2;$dialogHost=New-Node 3;$root.Add($background);$root.Add($dialogHost)
for($i=0;$i -lt 599;$i++){$background.Add((New-Node (1000+$i)))}
$dialog=New-Node 4 Window;$dialogHost.Add($dialog);$field=New-Node 5 Edit;$dialog.Add($field)
$rows=@(Read-Controls $root)
if('5' -notin @($rows.row.runtimeId) -or $script:order.IndexOf(5) -gt 6){throw 'Nested dialog was starved by background controls.'}
$results.Add(@{name='nested dialog outranks queued background list';passed=$true;visited=$script:visitedCount})
Reset-Case
$root=New-Node 1;$root.Add((New-Node 2 Edit));$root.Add((New-Node 2 Edit));$rows=@(Read-Controls $root)
if($rows.Count -ne 1 -or $script:visitedCount -ne 2){throw 'Duplicate runtime identity returned or visited.'}
$results.Add(@{name='runtime identities deduplicated';passed=$true})
Reset-Case
$root=New-Node 1
for($i=0;$i -lt 900;$i++){$root.Add((New-Node (1000+$i)))}
$rows=@(Read-Controls $root)
if($script:visitedCount -ne 600){throw 'Visited bound changed.'}
$results.Add(@{name='600 visited cap preserved';passed=$true})
Reset-Case
$root=New-Node 1 Window
for($i=0;$i -lt 300;$i++){$root.Add((New-Node (1000+$i) Edit))}
$rows=@(Read-Controls $root)
if($rows.Count -ne 150){throw 'Returned control bound changed.'}
$results.Add(@{name='150 controls cap preserved';passed=$true})
Reset-Case
$root=New-Node 1;$dialog=New-Node 2 Window;$root.Add($dialog)
$pw=New-Node 3 Edit;$pw.Current.IsPassword=$true;$dialog.Add($pw)
$off=New-Node 4 Edit;$off.Current.IsOffscreen=$true;$dialog.Add($off)
$disabled=New-Node 5 Edit;$disabled.Current.IsEnabled=$false;$dialog.Add($disabled)
$dialog.Add((New-Node 6 Edit));$rows=@(Read-Controls $root)
if($rows.Count -ne 1 -or $rows[0].row.runtimeId -ne '6'){throw 'Existing descriptor filtering lost.'}
$results.Add(@{name='all nodes still pass descriptor filters';passed=$true})
Reset-Case
$root=New-Node 1;$root.Add((New-Node 2 Edit));[DialogProbeWalker]::RepeatSibling=$true;$rows=@(Read-Controls $root)
if([DialogProbeWalker]::SiblingReads -gt 1200 -or $rows.Count -ne 1){throw 'Repeated sibling provider was not bounded.'}
$results.Add(@{name='repeating sibling provider bounded and deduplicated';passed=$true})
@{passed=$results.Count;total=$results.Count;fullCandidateParsed=$true;uiInvoked=$false;candidateSHA256=(Get-FileHash -Algorithm SHA256 -LiteralPath $candidatePath).Hash.ToLowerInvariant();results=@($results.ToArray())}|ConvertTo-Json -Depth 6
