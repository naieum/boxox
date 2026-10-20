export const MAIL_CATEGORIES = ["personal", "work", "transactional", "newsletter", "marketing", "notification", "spam", "phishing", "scam"] as const;
export const categoryLabel = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
