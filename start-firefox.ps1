Write-Output "Starting geckodriver"
$webdriverprocess = Start-Job -Init ([ScriptBlock]::Create("Set-Location '$pwd'")) -ScriptBlock { geckodriver *>&1 >$using:loglocation\webdriver.log }
Write-Output "Waiting for localhost:4444 to start from geckodriver"
Wait-For-HTTP-Response -RequestURL http://localhost:4444/
