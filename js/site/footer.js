// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Loads /footer.html into each airfrog.org page's #footer.

fetch('/footer.html')
    .then(response => response.text())
    .then(data => { document.getElementById('footer').innerHTML = data; });
