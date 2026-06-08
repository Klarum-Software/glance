# glance — Windows installer. Sets up the backend as a Scheduled Task that
# runs at logon. There is no GNOME extension on Windows — the browser at
# http://127.0.0.1:5172/ is the UI.

$ErrorActionPreference = "Stop"

$repoDir = (Resolve-Path "$PSScriptRoot\..").Path
$serverJs = Join-Path $repoDir "server\server.js"
$taskName = "klarum-glance"

Write-Host "glance Windows installer" -ForegroundColor White
Write-Host "  repo: $repoDir"

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Write-Host "node not found — install Node.js >=18 from https://nodejs.org/" -ForegroundColor Red
    exit 1
}
$nodeMajor = & node -p 'process.versions.node.split(".")[0]'
if ([int]$nodeMajor -lt 18) {
    Write-Host "node $nodeMajor is too old — need >=18" -ForegroundColor Red
    exit 1
}
Write-Host "  node: $(& node -v) at $node"

# remove existing task if present
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$serverJs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:UserName
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Klarum glance backend" | Out-Null
Write-Host "  ✓ scheduled task '$taskName' registered (runs at logon)" -ForegroundColor Green

# start it immediately so the user can see the dashboard now
Start-ScheduledTask -TaskName $taskName
Write-Host "  ✓ started"
Write-Host ""
Write-Host "next steps" -ForegroundColor White
Write-Host "  • Open http://127.0.0.1:5172/ — the dashboard should be live."
Write-Host "  • Manage: taskschd.msc (Task Scheduler)"
Write-Host "  • Stop:   Stop-ScheduledTask -TaskName $taskName"
Write-Host ""
Write-Host "done." -ForegroundColor Green
