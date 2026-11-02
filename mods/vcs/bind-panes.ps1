param([string]$Machine = '')
$ErrorActionPreference = 'Stop'

# Only fills instance identity in VCS props. No pane IDs, splits or terminals
# change. Compare-and-swap prevents overwriting concurrent app layout edits.
function Invoke-CoreRpc([string]$Method, [hashtable]$Params) {
    $client = [System.Diagnostics.Process]::new()
    $client.StartInfo.FileName = (Get-Command hc -ErrorAction Stop).Source
    $client.StartInfo.Arguments = 'connect'
    $client.StartInfo.UseShellExecute = $false
    $client.StartInfo.CreateNoWindow = $true
    $client.StartInfo.RedirectStandardInput = $true
    $client.StartInfo.RedirectStandardOutput = $true
    try {
        [void]$client.Start()
        $request = @{ jsonrpc = '2.0'; id = 1; method = $Method; params = $Params }
        $client.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 100 -Compress))
        $reply = $client.StandardOutput.ReadLineAsync()
        if (-not $reply.Wait(5000)) { throw "$Method timed out" }
        if (-not $reply.Result) { throw "$Method returned no response" }
        return ($reply.Result | ConvertFrom-Json -AsHashtable)
    } finally {
        if ($client.Id -and -not $client.HasExited) { $client.Kill() }
        $client.Dispose()
    }
}

function Set-PaneIdentity($Node) {
    if ($Node -isnot [System.Collections.IDictionary]) { return 0 }
    $count = 0
    if ($Node.type -eq 'block' -and $Node.content.mod -eq 'vcs') {
        if ($null -eq $Node.content.props) { $Node.content.props = @{} }
        if ($Node.content.props -isnot [System.Collections.IDictionary]) {
            throw 'VCS props must be an object; refusing to overwrite them'
        }
        if ($Node.content.props.vcsPane -ne $Node.id) {
            $Node.content.props.vcsPane = $Node.id
            $count++
        }
    }
    foreach ($child in $Node.children) { $count += Set-PaneIdentity $child }
    return $count
}

for ($attempt = 0; $attempt -lt 6; $attempt++) {
    $query = @{ name = 'herdr-app' }
    if ($Machine) { $query.on = $Machine }
    $reply = Invoke-CoreRpc 'doc.get' $query
    if ($reply.error) { throw ($reply.error | ConvertTo-Json -Compress) }
    $document = $reply.result.value
    $before = $document | ConvertTo-Json -Depth 100 -Compress
    $count = 0
    foreach ($space in $document.spaces) {
        foreach ($tab in $space.tabs) { $count += Set-PaneIdentity $tab.root }
    }
    if ($count -eq 0) { Write-Output 'VCS pane identities already bound'; exit 0 }
    $backupDir = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'data/vcs-pane-bindings'
    [void][System.IO.Directory]::CreateDirectory($backupDir)
    [System.IO.File]::WriteAllText((Join-Path $backupDir (([guid]::NewGuid().ToString()) + '.json')), $before)
    $query.version = $reply.result.version
    $query.value = $document
    $written = Invoke-CoreRpc 'doc.set' $query
    if (-not $written.error) { Write-Output "Bound $count VCS pane identities"; exit 0 }
    if ($written.error.data.kind -ne 'conflict') { throw ($written.error | ConvertTo-Json -Compress) }
}
throw 'VCS pane binding deferred: layout kept changing; try bind-panes.ps1 again'
