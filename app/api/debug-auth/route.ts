fetch('/api/debug-auth', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ refreshToken: '' })
}).then(r => r.json()).then(d => console.log(JSON.stringify(d, null, 2)))
