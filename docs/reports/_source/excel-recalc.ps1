param([Parameter(Mandatory=$true)][string]$Path)
# Opens a workbook in Excel, recalculates all formulas, saves it (so cached values exist), and reports error cells.
$full = (Resolve-Path $Path).Path
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false
$xl.DisplayAlerts = $false
try {
  $wb = $xl.Workbooks.Open($full)
  $xl.CalculateFull()
  $errors = @()
  foreach ($ws in $wb.Worksheets) {
    $used = $ws.UsedRange
    foreach ($cell in $used.Cells) {
      if ($cell.HasFormula -and ($cell.Text -match '^#')) { $errors += "$($ws.Name)!$($cell.Address($false,$false)) $($cell.Text)" }
    }
  }
  $wb.Worksheets.Item(1).Activate()
  $wb.Save()
  $wb.Close($true)
  if ($errors.Count -eq 0) { "recalc ok: no formula errors" } else { "formula errors:"; $errors }
} finally { $xl.Quit() }
