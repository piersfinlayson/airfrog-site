// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Loads /header.html into each airfrog.org page's #header and marks the link
// to the page displayed.

fetch('/header.html')
    .then(response => response.text())
    .then(data => {
        const header = document.getElementById('header');
        header.innerHTML = data;
        for (const link of header.querySelectorAll('nav a')) {
            if (link.pathname === location.pathname) link.setAttribute('aria-current', 'page');
        }
    });
