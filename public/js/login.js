(function () {
  const input = document.getElementById('password');
  const button = document.getElementById('password-toggle');
  if (!input || !button) return;
  button.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? 'Hide' : 'Show';
    button.setAttribute('aria-pressed', show ? 'true' : 'false');
  });
}());
