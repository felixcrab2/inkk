// Privacy Policy and Terms of Service text + modal components.
// Versioned by TOS_VERSION so we can prompt re-acceptance on material changes.

export const TOS_VERSION = "2026-06-30";

export const PRIVACY_POLICY = `Inkk Privacy Policy
Effective 30 June 2026

Inkk is a writing tool that records how you write so researchers can study human writing patterns. This page explains, in plain English, who is responsible for your data, what we collect, why, the legal basis we rely on, and what control you have.

WHO IS RESPONSIBLE FOR YOUR DATA (DATA CONTROLLER)

Inkk is operated by Felix Crabtree, the data controller for the personal data described here. You can reach us about any privacy matter, including the rights below, at hello@inkk.site.

WHAT WE COLLECT

When you write in Inkk, we record metadata about the writing process:
• The keys you press — including letters and digits — and the timing of keystrokes, pauses, and deletions
• Word counts and revision counts
• Caret-movement and selection events
• Basic device and environment context for each writing session — input method (touch or physical keyboard), operating-system platform, browser language, time zone, and the size of your browser window. This lets researchers account for differences between devices and is not used to identify you.
• For accounts: your email, username, and the documents you create and publish

We record the keys you press, together with their precise timing. This is what lets researchers study the fine-grained mechanics of typing — for example, that some letter pairs are typed faster because the keys sit closer together on the keyboard. Because the keystroke stream itself is recorded, text you type and later delete can in principle be reconstructed from it, not only the text you ultimately keep.

The content of the documents you save or publish is also stored, because the editor needs it to work across devices and the feed needs it to display publications. This content remains yours.

Please do not enter information you would not want recorded as part of the writing-process data — such as passwords, payment details, or sensitive personal information (for example about your health, religion, or political views). We do not seek this information and do not use the keystroke data to identify you, but because the keystroke stream can be reconstructed, anything you type forms part of the recorded process data.

WHY WE COLLECT IT, AND OUR LEGAL BASIS

Inkk is being used in a research study of human writing process. The goal is to eventually train an AI-detector grounded in how text was produced rather than what it says. We rely on the following legal bases under the UK GDPR and the EU GDPR:

• Running the service for you — creating your account, saving and publishing your documents, and showing your Human Signal score — is processing necessary to perform our contract with you (Article 6(1)(b)).
• Collecting and analysing writing-process metadata for research is carried out in our legitimate interests in studying human writing and developing AI-detection methods (Article 6(1)(f)), subject to the research safeguards in Article 89: you are identified only by an internal pseudonymous ID, and research outputs are anonymised. You have the right to object to this processing at any time by opting out in your Profile (see Your Rights). We have weighed this processing against your interests and consider it proportionate, given the safeguards and the easy opt-out.
• Keeping the feed safe through content moderation relies on our legitimate interests in preventing illegal and abusive content (Article 6(1)(f)).

HOW WE USE IT

• Anonymised research analysis. You are identified only by an internal ID, never by name or email, in research outputs.
• Computing your visible Human Signal score.
• Standard product features: editing, publishing, accounts.

We do not sell your data. We share data with third parties only as needed to run the service: our database and hosting provider (Supabase) and, for content moderation, OpenAI (see below). These providers process data on our behalf under data-processing terms.

WHERE YOUR DATA IS PROCESSED (INTERNATIONAL TRANSFERS)

Our service providers, including Supabase and OpenAI, may process your data on servers outside the United Kingdom and the European Economic Area, including in the United States. Where data is transferred outside the UK/EEA, we rely on appropriate safeguards — such as the European Commission's Standard Contractual Clauses and the UK International Data Transfer Addendum, applied through our providers' data-processing terms — to protect it.

STORAGE ON YOUR DEVICE

Inkk stores data in your browser (using local browser storage such as IndexedDB) so the editor can work, queue your work for sync, and compute your Human Signal score. This storage is necessary for the service to function. We do not use third-party advertising or tracking cookies.

KEEPING THE FEED SAFE (CONTENT MODERATION)

To keep the feed free of illegal and abusive content, the text and images you publish to the feed, the comments you post, and your profile picture are checked by an automated moderation service operated by OpenAI. We send only that content — never your keystroke data, your drafts, or your account details. OpenAI processes it to return a safety classification and, per its API terms, does not use it to train its models. Content may also be reported by other users. Anything flagged is reviewed by a moderator, who may hide content that breaks our Terms of Service.

YOUR RIGHTS

Under the UK GDPR and the EU GDPR you have the following rights over your personal data. To exercise any of them, use the tools in your Profile where available, or contact us at hello@inkk.site. We aim to respond within one month.

• Access: see what we hold about you. You can export all your captured process data as JSON at any time from your Profile.
• Portability: receive your process data in a machine-readable format — the same JSON export.
• Erasure: permanently delete your captured process data at any time from your Profile, or ask us to remove your account entirely.
• Object / opt out: turn off research sharing at any time in your Profile. After opt-out, no new data is recorded to our servers. (Local recording continues only to power your own Human Signal score, and is cleared from your device on opt-out.)
• Rectification: ask us to correct inaccurate account information.
• Restriction: ask us to limit how we use your data while a question or objection is resolved.
• Complain: if you are unhappy with how we handle your data, you can lodge a complaint with your local data-protection authority. In the UK this is the Information Commissioner's Office (ico.org.uk); in the EU it is the supervisory authority in your country.

AGE

Inkk is not intended for children. You must be at least 16 years old to create an account or contribute writing-process data.

DATA RETENTION

We retain process data until you delete it or close your account. When you close your account, we delete your account and associated process data within a reasonable period, except where we must keep limited information to meet a legal obligation.

CHANGES TO THIS POLICY

We may update this policy. Material changes will be communicated in-app before they take effect, and you will be asked to re-accept.

CONTACT

hello@inkk.site
`;

export const TERMS_OF_SERVICE = `Inkk Terms of Service
Effective 30 June 2026

By creating an Inkk account or using the service, you agree to these terms.

1. THE SERVICE
Inkk is a writing tool with a "Human Signal" feature that surfaces process information about a piece of writing. Inkk is provided as-is, for personal, lawful use.

2. YOUR ACCOUNT
You must be at least 16 years old to use Inkk. You are responsible for keeping your account credentials secure. Notify us promptly if your account is compromised.

3. YOUR CONTENT
You own the writing you create on Inkk. By publishing a piece to the Inkk feed, you grant Inkk a non-exclusive licence to display that publication on the platform. We do not claim ownership of your writing.

4. ACCEPTABLE USE
You agree not to use Inkk to publish illegal, harassing, infringing, or otherwise harmful content. Do not attempt to reverse-engineer the Human Signal score, abuse the platform, or scrape other users' data.

5. MODERATION AND REPORTING
Content you publish to the feed and comments you post are screened by an automated moderation service (see the Privacy Policy) and may be reported by other users. We may review, hide, or remove content that violates these terms, and may suspend repeat offenders. You can report content you believe breaks these terms using the report option on a piece or comment.

6. RESEARCH PARTICIPATION
Inkk includes a research study of human writing process. By default, your writing-process metadata contributes to Inkk's research dataset, where you are identified only by a pseudonymous internal ID. We rely on our legitimate interests as the legal basis for this research, and you have the right to object: you can opt out at any time in your Profile, and no new data will be recorded after you do. The Privacy Policy explains what is and is not collected.

7. TERMINATION
You may delete your account at any time. We may suspend or terminate accounts that violate these terms.

8. DISCLAIMERS
Inkk is provided "AS IS" without warranties. The Human Signal score is a heuristic and not a guarantee. We are not liable for losses from outages, data loss, or score inaccuracies.

9. CHANGES
We may update these terms. Continued use after changes constitutes acceptance. Material changes will be communicated in-app before they take effect.

10. CONTACT
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
