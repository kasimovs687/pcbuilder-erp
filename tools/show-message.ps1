# =============================================================================
#  PCBuilder ERP - показывает сообщения на русском языке.
#
#  Почему текст лежит в отдельном файле: cmd.exe читает .bat в OEM-кодировке,
#  а Windows PowerShell 5.1 читает .ps1 как ANSI — русская строка в любом из
#  этих файлов превращается в мусор и может сломать разбор скрипта.
#  Здесь текст хранится в UTF-8 с BOM, который PowerShell читает правильно.
#
#  Запуск: powershell -File tools\show-message.ps1 -CheckNode
# =============================================================================
[CmdletBinding()]
param(
  [switch]$CheckNode,
  [switch]$Help
)

try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

function Say {
  param([object[]]$Lines)
  foreach ($l in $Lines) { Write-Host $l }
}

if ($Help) {
  Say @(
    '  PCBuilder ERP — справка по запуску',
    '',
    '  1. Двойной клик по start.bat — сервер поднимется и откроется браузер.',
    '  2. Нужен Node.js 22.5+: https://nodejs.org (версия LTS).',
    '  3. Остановить сервер: stop.bat или Ctrl+C в окне сервера.',
    '',
    '  Адреса: / (главная), /builder (конфигуратор), /client (кабинет клиента),',
    '          /assembler (панель сборщика), /track (отслеживание доставки).',
    ''
  )
  exit 0
}

if ($CheckNode) {
  $root = Split-Path -Parent $PSScriptRoot
  $candidates = @(
    (Join-Path $root 'runtime\node.exe'),
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LocalAppData 'Programs\nodejs\node.exe'),
    (Join-Path $env:APPDATA 'nvm\node.exe'),
    (Join-Path $env:USERPROFILE '.workbuddy-ai\binaries\node\versions\current\node.exe')
  )

  $node = $null
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { $node = $c; break }
  }
  if (-not $node) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
  }

  if (-not $node) {
    Say @(
      '  [ОШИБКА] Node.js не найден.',
      '',
      '  Установите Node.js 22.5 или новее: https://nodejs.org',
      '  (выберите версию LTS), затем запустите start.bat заново.',
      '',
      '  Либо положите node.exe в папку "runtime" рядом с start.bat —',
      '  лаунчер подхватит его автоматически.',
      ''
    )
    exit 2
  }

  $ver = (& $node -v) 2>&1
  $major = 0
  $minor = 0
  if ($ver -match 'v(\d+)\.(\d+)') {
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
  }
  if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
    Say @(
      "  [ВНИМАНИЕ] Установлен Node.js $ver, а нужна версия 22.5 или новее.",
      '  Встроенный модуль node:sqlite (база данных) есть только в новых версиях.',
      ''
    )
  } else {
    Write-Host ("  Node.js : " + $ver)
    Write-Host ("  Путь    : " + $node)
    Write-Host ''
  }
  exit 0
}

Say @(
  '  PCBuilder ERP',
  '',
  '  Запуск: start.bat   ·   Остановка: stop.bat   ·   Справка: tools\show-message.ps1 -Help',
  ''
)
exit 0
