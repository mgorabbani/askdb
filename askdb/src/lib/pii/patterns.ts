export type PiiConfidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";

const HIGH_PATTERNS = [
  /^e[-_]?mail(_address)?$/i,
  /^ssn$|^social_security$|^sin$|^tax_id$|^national_id$/i,
  /^pass(word|wd|_hash)$/i,
  /^credit_card$|^card_number$|^cc_num$|^pan$/i,
  /^(phone|mobile|cell|telephone|fax)(_number)?$/i,
  /^(address|street|zip|postal)(_code)?$|^city$/i,
  /^(dob|date_of_birth|birth_date|birthday)$/i,
  /^(ip_address|ip|user_ip|client_ip)$/i,
];

const MEDIUM_PATTERNS = [
  /^(first|last|full)[-_]?name$|^name$|^user[-_]?name$|^display[-_]?name$/i,
  /^(api[-_]?key|secret|token|auth[-_]?token|access[-_]?token|refresh[-_]?token)$/i,
  /^(bank[-_]?account|iban|routing|swift)$/i,
  /^(passport|license[-_]?number|driver[-_]?license)$/i,
  /^(lat|lng|latitude|longitude|location|geo)$/i,
];

const LOW_PATTERNS = [
  /^(avatar|photo|image|picture)$/i,
  /^(bio|about|description)$/i,
  /^(notes|comments|memo)$/i,
];

export function detectPii(fieldName: string): PiiConfidence {
  // Use the leaf part for nested fields (e.g., "address.zip" -> "zip")
  const leaf = fieldName.includes(".") ? fieldName.split(".").pop()! : fieldName;

  if (HIGH_PATTERNS.some((p) => p.test(leaf))) return "HIGH";
  if (MEDIUM_PATTERNS.some((p) => p.test(leaf))) return "MEDIUM";
  if (LOW_PATTERNS.some((p) => p.test(leaf))) return "LOW";
  return "NONE";
}
