param([Parameter(Mandatory=$true)][string]$InputPath, [Parameter(Mandatory=$true)][string]$OutputPdf)
# Exports .docx via Word or .pptx via PowerPoint to PDF (faithful rendering for QA)
$in = (Resolve-Path $InputPath).Path
$ext = [IO.Path]::GetExtension($in).ToLower()
if ($ext -eq '.docx') {
  $app = New-Object -ComObject Word.Application
  $app.Visible = $false
  try {
    $doc = $app.Documents.Open($in, $false, $true)
    $doc.Fields.Update() | Out-Null
    foreach ($toc in $doc.TablesOfContents) { $toc.Update() | Out-Null }
    $doc.ExportAsFixedFormat($OutputPdf, 17)
    $doc.Close($false)
  } finally { $app.Quit() }
} elseif ($ext -eq '.pptx') {
  $app = New-Object -ComObject PowerPoint.Application
  try {
    $pres = $app.Presentations.Open($in, $true, $false, $false)
    $pres.SaveAs($OutputPdf, 32)
    $pres.Close()
  } finally { $app.Quit() }
} else { throw "unsupported: $ext" }
"exported $OutputPdf"
