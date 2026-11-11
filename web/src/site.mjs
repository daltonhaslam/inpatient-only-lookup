// Facts about the site itself, used by the build and the browser.
export const SITE = {
  name: 'Inpatient Only Lookup',
  url: 'https://inpatient-only-lookup.vercel.app',
  repo: 'https://github.com/daltonhaslam/inpatient-only-lookup',
  author: 'Dalton Haslam, MD, MBA',
  linkedin: 'https://www.linkedin.com/in/dalton-haslam',
  family: 'https://paidandpenalized.org',
};

// Reader feedback: a shared Google Form with the site and page prefilled (both visible to the reader).
const FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSekdB41siZs44_4gLNBGD2OqalK2TGNk7o8Q0bHl20ggYBy_Q/viewform';
export const feedbackHref = (path) =>
  `${FORM}?entry.2047320042=${encodeURIComponent(SITE.name)}&entry.1326474028=${encodeURIComponent(SITE.url + path)}`;

// CMS's status indicators, in this site's words (CY 2027 OPPS final rule, Addendum D1).
export const STATUS = {
  C: 'inpatient procedure, not paid under the outpatient system',
  J1: 'paid as an outpatient service through a comprehensive APC',
  N: 'no separate outpatient payment; packaged into the payment for other services',
  T: 'paid as an outpatient service; the multiple-procedure reduction applies',
  S: 'paid as an outpatient service; not reduced when multiple',
  Q1: 'outpatient service, packaged when billed with certain other services and otherwise paid separately',
  Q2: 'outpatient service, packaged when billed with certain procedures and otherwise paid separately',
  E1: 'not paid by Medicare on outpatient claims',
  D: 'discontinued code',
};

export const CFR = {
  '412.3': 'https://www.ecfr.gov/current/title-42/section-412.3',
  '419.22': 'https://www.ecfr.gov/current/title-42/section-419.22',
};
