<#
.SYNOPSIS
    CI smoke test for desktop\update-and-run.ps1 (no Pester).

.DESCRIPTION
    1. Parses the launcher with the PowerShell parser and fails on any syntax error.
    2. Fails if the script does not declare the -Ref (default 'stable') and
       -WaitForPid parameters the app's Version menu depends on.
    3. Extracts the launcher's pure helper functions by name and asserts them.
    Run under Windows PowerShell 5.1 (the launcher's target):
        powershell -NoProfile -File desktop\tests\check-launcher.ps1
#>
$ErrorActionPreference = 'Stop'

$launcher = Join-Path $PSScriptRoot '..\update-and-run.ps1'
$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure { param([string]$Message) $failures.Add($Message); Write-Host "FAIL: $Message" -ForegroundColor Red }

function Assert-Equal {
    param($Actual, $Expected, [string]$What)
    if ($Actual -ne $Expected) { Add-Failure "$What : expected '$Expected' but got '$Actual'" }
}

# 1. parse
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $launcher).Path, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) {
    foreach ($e in $errors) { Add-Failure "parse error at line $($e.Extent.StartLineNumber): $($e.Message)" }
    exit 1
}

# 2. parameters
$params = @{}
if ($ast.ParamBlock) {
    foreach ($p in $ast.ParamBlock.Parameters) { $params[$p.Name.VariablePath.UserPath] = $p }
}
if (-not $params.ContainsKey('Ref')) { Add-Failure 'update-and-run.ps1 has no -Ref parameter' }
elseif ($params['Ref'].DefaultValue.Value -ne 'stable') { Add-Failure "-Ref must default to 'stable'" }
if (-not $params.ContainsKey('WaitForPid')) { Add-Failure 'update-and-run.ps1 has no -WaitForPid parameter' }

# 3. pure helpers
foreach ($name in 'Test-LaunchableRef', 'Get-SafeCommit', 'Test-SafeStampValue') {
    $fn = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true) | Select-Object -First 1
    if (-not $fn) { Add-Failure "helper function $name not found"; continue }
    Invoke-Expression $fn.Extent.Text
}

if ($failures.Count -eq 0) {
    foreach ($ok in 'stable', 'testing/flu-preferred', 'testing/v1.2_rc', 'testing/Foo') {
        Assert-Equal (Test-LaunchableRef $ok) $true "Test-LaunchableRef '$ok'"
    }
    $bad = @(
        '', 'main', 'Stable', 'testing/', 'testing/a b', 'testing/a"b', '--help', 'testing/a/b', 'testing/-x',
        "stable`n", "testing/x`n", 'testing/a..b', 'testing/x.lock', 'testing/x.',
        'testing/aux', 'testing/CON', 'testing/nul', 'testing/com1', 'testing/lpt9', 'testing/aux.txt'
    )
    foreach ($b in $bad) { Assert-Equal (Test-LaunchableRef $b) $false "Test-LaunchableRef '$($b -replace "`n",'\n')'" }
    Assert-Equal (Test-LaunchableRef 'testing/console') $true "Test-LaunchableRef 'testing/console'"

    Assert-Equal (Get-SafeCommit '1a2b3c4') '1a2b3c4' 'Get-SafeCommit sha'
    Assert-Equal (Get-SafeCommit " 1a2b3c4d5e `n") '1a2b3c4d5e' 'Get-SafeCommit trims'
    Assert-Equal (Get-SafeCommit 'warning: unable to access config') 'unknown' 'Get-SafeCommit warning text'
    Assert-Equal (Get-SafeCommit '1a2b3c4;rm') 'unknown' 'Get-SafeCommit injection'
    Assert-Equal (Get-SafeCommit "1a2b3c4`nwarning") 'unknown' 'Get-SafeCommit multi-line'
    Assert-Equal (Get-SafeCommit '') 'unknown' 'Get-SafeCommit empty'

    Assert-Equal (Test-SafeStampValue 'C:\Users\Jane Doe\claude\vaccine-assist') $true 'Test-SafeStampValue normal path'
    Assert-Equal (Test-SafeStampValue 'C:\Program Files (x86)\va') $true 'Test-SafeStampValue parentheses'
    foreach ($badValue in 'C:\a;b', 'C:\a"b', 'C:\a%b', 'C:\a*b', 'C:\a$b', '', ' ') {
        Assert-Equal (Test-SafeStampValue $badValue) $false "Test-SafeStampValue '$badValue'"
    }
}

if ($failures.Count -gt 0) {
    Write-Host "$($failures.Count) launcher check(s) failed." -ForegroundColor Red
    exit 1
}
Write-Host 'update-and-run.ps1: parse OK, parameters OK, helper checks OK.' -ForegroundColor Green
