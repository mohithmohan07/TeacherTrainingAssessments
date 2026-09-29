// Languages the generator offers by name, with the script Gemini must write
// them in, the HTML language code, and the writing direction. The page loads a
// Noto font for every script here (see public/css/fonts.css), so papers print
// correctly on any computer. Other languages can still be typed in; they are
// written left to right in whatever script Gemini chooses.

export const LANGUAGES = [
  { name: 'English', code: 'en', script: 'Latin' },
  { name: 'Hindi', code: 'hi', script: 'Devanagari' },
  { name: 'Sanskrit', code: 'sa', script: 'Devanagari' },
  { name: 'Marathi', code: 'mr', script: 'Devanagari' },
  { name: 'Konkani', code: 'kok', script: 'Devanagari' },
  { name: 'Nepali', code: 'ne', script: 'Devanagari' },
  { name: 'Maithili', code: 'mai', script: 'Devanagari' },
  { name: 'Bodo', code: 'brx', script: 'Devanagari' },
  { name: 'Dogri', code: 'doi', script: 'Devanagari' },
  { name: 'Bengali', code: 'bn', script: 'Bengali' },
  { name: 'Assamese', code: 'as', script: 'Assamese (Bengali-Assamese script)' },
  { name: 'Kannada', code: 'kn', script: 'Kannada' },
  { name: 'Tulu', code: 'tcy', script: 'Kannada' },
  { name: 'Tamil', code: 'ta', script: 'Tamil' },
  { name: 'Telugu', code: 'te', script: 'Telugu' },
  { name: 'Malayalam', code: 'ml', script: 'Malayalam' },
  { name: 'Gujarati', code: 'gu', script: 'Gujarati' },
  { name: 'Punjabi', code: 'pa', script: 'Gurmukhi' },
  { name: 'Odia', code: 'or', script: 'Odia' },
  { name: 'Urdu', code: 'ur', script: 'Perso-Arabic (Nastaliq style)', rtl: true },
  { name: 'Kashmiri', code: 'ks', script: 'Perso-Arabic, with the Kashmiri vowel marks', rtl: true },
  { name: 'Santali', code: 'sat', script: 'Ol Chiki' },
  { name: 'French', code: 'fr', script: 'Latin' },
  { name: 'German', code: 'de', script: 'Latin' },
];

export function findLanguage(name) {
  const wanted = String(name ?? '').trim().toLowerCase();
  return LANGUAGES.find((language) => language.name.toLowerCase() === wanted) ?? null;
}
