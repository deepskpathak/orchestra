export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 3) + '...';
}
