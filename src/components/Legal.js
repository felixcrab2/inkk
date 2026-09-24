// Privacy Policy and Terms of Service text + modal components.
// Versioned by TOS_VERSION; the date changes when the text does.
// The companion reads TOS_VERSION too (it stamps profiles.tos_version when it
// provisions an account-free writer), so bump it here and nowhere else.

export const TOS_VERSION = "2026-09-24";

export const PRIVACY_POLICY = `Inkk Privacy Policy
Effective 24 September 2026

Inkk is a writing tool in two parts: an editor at inkk.site and a desktop companion for macOS. Both pay attention to how you write — the rhythm of your typing — so that a piece can carry a code showing it was written by a person. This page explains, in plain English, who is responsible for your data, what each part collects, why, the legal basis we rely on, and what control you have.

WHO IS RESPONSIBLE FOR YOUR DATA (DATA CONTROLLER)

Inkk is operated by Felix Crabtree, the data controller for the personal data described here. You can reach us about any privacy matter, including the rights below, at hello@inkk.site.

WHAT THE WEB EDITOR COLLECTS

When you write in the editor at inkk.site, we record metadata about the writing process:
• The keys you press — including letters, digits and punctuation — and the precise timing of each key down and key up, pause and deletion
• Insertions, deletions and pastes, with how many characters each one added or removed (for a paste, the length of the pasted text)
• Caret movement and selection events
• Word counts and revision counts, and the Human Signal score computed from all of the above
• Basic device and environment context once per writing session — whether the device has a touch screen, operating-system platform, browser language, time zone, and the size of your browser window. This lets researchers account for differences between devices and is not used to identify you.

Because the keystroke stream itself is recorded, text you type and later delete can in principle be reconstructed from it, not only the text you ultimately keep. Please do not type anything into the editor that you would not want recorded as part of the writing-process data — such as passwords, payment details, or sensitive personal information (for example about your health, religion, or political views). We do not seek this information and do not use the keystroke data to identify you.

Your notes are stored in your browser. If you are signed in, they are also saved to our database so they follow you between devices: the text, its title, and the process metrics above. Downloads (PDF and PNG) are rendered in your browser and upload nothing.

WHAT THE DESKTOP COMPANION COLLECTS

The companion is a menu-bar app that runs in the background on your Mac and records the rhythm of your typing in whatever app you are writing in. It is built so that it cannot see what you write:
• It records the timing of each key down and key up, and only the broad class of key — letter, digit, punctuation, space, edit, navigation or modifier. Which letter was pressed is never recorded (that field is always empty).
• When you paste, it records only that a paste happened. It never reads the clipboard. How much of a finished piece arrived by pasting is worked out at certify time by comparing the length of the finished text with what was typed.
• When you certify a session, it reads the text of the document in front through macOS Accessibility, once, on your Mac, to compute the fingerprint. The text is discarded immediately; it is never stored and never sent. If the app will not share its text, the certificate is bound to the writing session instead and says so.
• While you read, it looks at the text the front window is showing for an inkk code or seal link, on your Mac, so it can show you the certificate of what you are reading. Only a code it finds is looked up; the text is not kept. You can turn this off in Settings.
• It records which app you were typing in (its name and bundle identifier), so that sessions can be grouped per app.
• It never sees password fields: macOS switches on secure input for those, which blocks the keyboard hook entirely.
• Apps on your ignored list are never recorded, and you can pause recording at any time.

Everything the companion records stays on your Mac, in its own folder in your Application Support directory, until you choose to certify a session. When you certify, the rhythm events of that one session are sent to our server to compute the score, together with the text's word count and character count, its fingerprint (a SHA-256 hash), the name and bundle identifier of the app the session was typed in, and your operating system. The text itself is hashed on your Mac and is never sent. The server uses the rhythm events to compute the score and does not keep them.

If you certify from the companion without an account, Inkk creates an anonymous account for you — a random identifier with no email address — so that the certificate has an owner in the ledger. That account stays tied to the companion on that Mac: certificates it issued cannot later be moved onto an email account. If you want them removed, write to hello@inkk.site with the codes.

THE RESEARCH STUDY

Inkk is being used in a research study of the human writing process. The goal is to eventually train an AI-detector grounded in how text was produced rather than what it says.

If you have an account and research sharing is on (it is on by default when you create an account, and you can turn it off at any time under Notes), the process data recorded by the web editor is uploaded to our database under a pseudonymous internal ID. After you opt out, no new data is uploaded; recording continues only on your own device, to power your own Human Signal score. You can download everything we hold as JSON, and delete it, at any time from Notes.

The companion does not take part in the study: its events leave your Mac only when you certify a session, and then only to compute that certificate.

THE CERTIFICATION LEDGER

When you certify a piece, one row is added to an append-only ledger: the code (INKK-XXXX-XXXX-XXXX), the title you gave the piece (optional), your author name and username if your account has them, the SHA-256 fingerprint of the text, its word count, the Human Signal score and tier, whether it met the verified threshold, the time it was issued, and your internal user ID. The ledger never holds the text of the piece and never holds keystroke data.

Anyone who has a code can look it up at inkk.site/certify and will see the code, title, author name and username, fingerprint, word count, score, tier and the date it was issued. Please choose your title and name with that in mind: they are the only human-readable parts of a certificate. A code cannot be edited once issued; editing a piece and certifying it again issues a new code.

ACCOUNT DATA

For accounts we hold your email address, a hashed password (handled by our authentication provider; we never see the password itself), your username and display name, when you accepted these terms and which version, and your research-sharing setting. If you sign in with Google, Google shares your email address and name with us. An anonymous account created by the companion holds only a random identifier.

WHY WE COLLECT IT, AND OUR LEGAL BASIS

We rely on the following legal bases under the UK GDPR and the EU GDPR:
• Running the service for you — creating your account, syncing your notes, issuing and verifying certificates, and showing your Human Signal score — is processing necessary to perform our contract with you (Article 6(1)(b)).
• Collecting and analysing writing-process metadata for research is carried out in our legitimate interests in studying human writing and developing AI-detection methods (Article 6(1)(f)), subject to the research safeguards in Article 89: you are identified only by an internal pseudonymous ID, and research outputs are anonymised. You have the right to object to this processing at any time by opting out under Notes. We have weighed this processing against your interests and consider it proportionate, given the safeguards and the easy opt-out.

HOW WE USE IT

• Computing your visible Human Signal score and issuing certificates
• Anonymised research analysis, where you are identified only by an internal ID, never by name or email
• Standard product features: the editor, notes, accounts

We do not sell your data. We do not use it for advertising. We share data with third parties only as needed to run the service: Supabase, which hosts our database and authentication, and Vercel, which hosts the website and the certification function and collects aggregate, cookie-free page analytics. There are no other processors. Both process data on our behalf under data-processing terms.

WHERE YOUR DATA IS PROCESSED (INTERNATIONAL TRANSFERS)

Supabase and Vercel may process your data on servers outside the United Kingdom and the European Economic Area, including in the United States. Where data is transferred outside the UK/EEA, we rely on appropriate safeguards — such as the European Commission's Standard Contractual Clauses and the UK International Data Transfer Addendum, applied through our providers' data-processing terms — to protect it.

STORAGE ON YOUR DEVICE

The website stores data in your browser (local storage and IndexedDB) so the editor works offline, your notes are kept, and your Human Signal score can be computed. The companion stores its settings, sessions and certificates in a folder under Application Support. Both are necessary for the service to function. We do not use third-party advertising or tracking cookies.

YOUR RIGHTS

Under the UK GDPR and the EU GDPR you have the following rights over your personal data. To exercise any of them, use the tools under Notes where available, or contact us at hello@inkk.site. We aim to respond within one month.

• Access: see what we hold about you. You can download all your captured process data as JSON at any time from Notes.
• Portability: receive your process data in a machine-readable format — the same JSON export.
• Erasure: use "Delete my data" under Notes to permanently delete your captured process data. To delete your account entirely — including your notes, your certificates and the anonymous account the companion may have created — email hello@inkk.site from the address on the account and we will do it.
• Object / opt out: turn off research sharing at any time under Notes. After opt-out, no new data is uploaded to our servers.
• Rectification: ask us to correct inaccurate account information.
• Restriction: ask us to limit how we use your data while a question or objection is resolved.
• Complain: if you are unhappy with how we handle your data, you can lodge a complaint with your local data-protection authority. In the UK this is the Information Commissioner's Office (ico.org.uk); in the EU it is the supervisory authority in your country.

AGE

Inkk is not intended for children. You must be at least 16 years old to create an account, use the companion, or contribute writing-process data.

DATA RETENTION

We retain process data until you delete it or close your account. Certificates stay in the ledger until the account that issued them is deleted, at which point their codes stop verifying. When you close your account we delete it and its associated data within a reasonable period, except where we must keep limited information to meet a legal obligation.

CHANGES TO THIS POLICY

We may update this policy. The date at the top changes when the text does; continuing to use Inkk after a change means you accept the new version.

CONTACT

hello@inkk.site
`;

export const TERMS_OF_SERVICE = `Inkk Terms of Service
Effective 24 September 2026

By creating an Inkk account, certifying a piece, or using the editor or the desktop companion, you agree to these terms.

1. THE SERVICE
Inkk is a writing tool with a "Human Signal" feature that surfaces process information about a piece of writing: an editor and notes at inkk.site, a certification ledger that issues and verifies codes, and a desktop companion for macOS that records the rhythm of typing in other apps. Inkk is provided as-is, for personal, lawful use, and you use it at your own risk.

2. YOUR ACCOUNT
You must be at least 16 years old to use Inkk. You are responsible for keeping your account credentials secure, and for anything done with them. Notify us promptly if your account is compromised. If you certify from the companion without signing in, an anonymous account is created for you; it is yours, and these terms apply to it in the same way.

3. YOUR WRITING
You own the writing you create with Inkk. We store your notes only so that the editor can sync them between your devices, and we use them for nothing else. We do not claim ownership of, or any licence over, your writing beyond what is needed to provide the service to you. The certification ledger holds a fingerprint of your text, never the text.

4. CERTIFICATES
A certificate records that the keystroke rhythm behind a piece of text looked like a person typing, at the time it was certified, according to our scoring. It is evidence of process, not proof of authorship, originality or quality, and it says nothing about what the text means. We do not adjudicate disputes about who wrote what, and a certificate must not be presented as if it did. Codes are permanent: a certificate cannot be edited once issued, and certifying an edited version issues a new code. Do not misrepresent what a code shows, and do not present a code for text other than the text it was issued for.

5. ACCEPTABLE USE
You agree not to use Inkk for anything unlawful, and not to abuse the service — in particular, not to fabricate or replay keystroke data, not to attempt to reverse-engineer or game the Human Signal score, not to use automated tools against the ledger, the editor or the certification endpoint, and not to try to enumerate or scrape other people's certificates or data. Do not run the companion on a Mac where it would record another person's typing without their knowledge and consent.

6. THE DESKTOP COMPANION
The companion needs the macOS Accessibility and Input Monitoring permissions to work, and records the rhythm of typing in every app except those you ignore, until you pause or quit it. You are responsible for deciding whether to install it and for what it is allowed to see on your Mac. It never records which letters you type; the Privacy Policy explains exactly what it does record.

7. RESEARCH PARTICIPATION
Inkk includes a research study of the human writing process. If you have an account, your writing-process metadata from the web editor contributes to Inkk's research dataset by default, where you are identified only by a pseudonymous internal ID. We rely on our legitimate interests as the legal basis for this research, and you have the right to object: you can opt out at any time under Notes, and no new data will be uploaded after you do. The Privacy Policy explains what is and is not collected.

8. TERMINATION
You may stop using Inkk at any time and ask us to delete your account. We may suspend or terminate accounts that violate these terms.

9. DISCLAIMERS AND LIABILITY
Inkk is provided "AS IS" without warranties of any kind. The Human Signal score is a heuristic and not a guarantee; it can be wrong in either direction. To the fullest extent the law allows, we are not liable for losses arising from outages, data loss, score inaccuracies, or reliance on a certificate.

10. CHANGES
We may update these terms. Continued use after changes constitutes acceptance. Material changes will be communicated in-app before they take effect.

11. CONTACT
hello@inkk.site
`;

function LegalModal({ title, body, onClose }) {
  return (
    <div className="legal-overlay" onClick={onClose}>
      <div className="legal-modal" onClick={e => e.stopPropagation()}>
        <button className="legal-close" onClick={onClose} aria-label="Close">×</button>
        <h2 className="legal-title">{title}</h2>
        <pre className="legal-body">{body}</pre>
      </div>
    </div>
  );
}

export function PrivacyModal({ onClose })  { return <LegalModal title="Privacy Policy"   body={PRIVACY_POLICY}    onClose={onClose} />; }
export function TermsModal({ onClose })    { return <LegalModal title="Terms of Service" body={TERMS_OF_SERVICE}  onClose={onClose} />; }
