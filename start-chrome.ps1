Write-Output "Starting chromedriver"
$webdriverprocess = Start-Job -Init ([ScriptBlock]::Create("Set-Location '$pwd'")) -ScriptBlock { chromedriver --port=4444 --log-level=INFO *>&1 >$using:loglocation\webdriver.log }
Write-Output "Waiting for localhost:4444 to start from chromedriver"
Wait-For-HTTP-Response -RequestURL http://localhost:4444/
