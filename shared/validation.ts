export const PASSWORD_RULES = {
  minLength: 8,
  requireLetter: true,
  requireNumber: true,
} as const;

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidPassword(password: string): boolean {
  if (password.length < PASSWORD_RULES.minLength) return false;
  if (PASSWORD_RULES.requireLetter && !/[a-zA-Z]/.test(password)) return false;
  if (PASSWORD_RULES.requireNumber && !/[0-9]/.test(password)) return false;
  return true;
}

export const STACKS_ADDRESS_REGEX = /^SP[A-Z0-9]{38}$/;
export const STACKS_PRIVATE_KEY_REGEX = /^[0-9a-fA-F]{64}$/;
