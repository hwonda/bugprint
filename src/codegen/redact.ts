/**
 * Structure-preserving PII redaction for values typed by real users.
 * The shape (an e-mail is still an e-mail, a 16-digit card number is still 16
 * digits, a phone keeps its prefix) is kept so client-side validation behaves
 * the same on replay.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DIGIT_RUN = /\+?\d[\d ().-]{6,}\d/g;
const CARD_FAKE = '4242424242424242424';

export function redactValue(value: string): string {
  return value.replace(EMAIL, 'user@example.com').replace(DIGIT_RUN, (m) => {
    const digits = m.replace(/\D/g, '').length;
    let i = 0;
    if (digits >= 13 && digits <= 19) return m.replace(/\d/g, () => CARD_FAKE[i++]!); // card
    if (digits >= 9 && digits <= 12) return m.replace(/\d/g, (d) => (i++ < 3 ? d : '0')); // phone: keep prefix
    return m;
  });
}
