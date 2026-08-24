// AdCP compliance fixture: intentionally violates two creative policies.
// The .invalid destinations are reserved and cannot reach a real service.
window.location.assign('https://policy-backed-auto-redirect.invalid/landing');
fetch('http://policy-backed-insecure-request.invalid/pixel');
