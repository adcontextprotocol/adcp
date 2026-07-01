// WorkOS surfaces email-collision rejections in several shapes: an
// `email_already_exists` / `email_not_available` code, a 409, or — as seen
// in production — a `GenericServerException` with status 422 and message
// "This email is not available." A bare 422 alone is NOT enough: WorkOS
// returns 422 for many unrelated validation failures, so we require a
// message match too.
export function isEmailUnavailable(error: any): boolean {
  if (!error) return false;
  if (error.code === 'email_already_exists' || error.code === 'email_not_available') return true;
  if (error.status === 409) return true;
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  const messageMatches =
    message.includes('email is not available') ||
    message.includes('email already exists') ||
    message.includes('email already in use');
  if (error.status === 422 && messageMatches) return true;
  return messageMatches;
}
