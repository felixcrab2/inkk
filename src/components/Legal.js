// Privacy Policy and Terms of Service text + modal components.
// Versioned by TOS_VERSION so we can prompt re-acceptance on material changes.

export const TOS_VERSION = "2026-06-29";

export const PRIVACY_POLICY = `Inkk Privacy Policy
Effective 29 June 2026

Inkk is a writing tool that records how you write so researchers can study human writing patterns. This page explains, in plain English, what we collect, why, and what control you have.

WHAT WE COLLECT

When you write in Inkk, we record metadata about the writing process:
• The keys you press — including letters and digits — and the timing of keystrokes, pauses, and deletions
• Word counts and revision counts
• Caret-movement and selection events
• Basic device and environment context for each writing session — input method (touch or physical keyboard), operating-system platform, browser language, time zone, and the size of your browser window. This lets researchers account for differences between devices and is not used to identify you.
• For accounts: your email, username, and the documents you create and publish

We record the keys you press, together with their precise timing. This is what lets researchers study the fine-grained mechanics of typing — for example, that some letter pairs are typed faster because the keys sit closer together on the keyboard. Because the keystroke stream itself is recorded, text you type and later delete can in principle be reconstructed from it, not only the text you ultimately keep.

The content of the documents you save or publish is also stored, because the editor needs it to work across devices and the feed needs it to display publications. This content remains yours.

WHY WE COLLECT IT

Inkk is being used in a research study of human writing process. The goal is to eventually train an AI-detector grounded in how text was produced rather than what it says.

HOW WE USE IT

• Anonymised research analysis. You are identified only by an internal ID, never by name or email, in research outputs.
• Computing your visible Human Signal score.
• Standard product features: editing, publishing, accounts.

We do not sell your data. We share data with third parties only as needed to run the service: our database provider (Supabase) and, for content moderation, OpenAI (see below).

KEEPING THE FEED SAFE (CONTENT MODERATION)

To keep the feed free of illegal and abusive content, the text and images you publish to the feed, the comments you post, and your profile picture are checked by an automated moderation service operated by OpenAI. We send only that content — never your keystroke data, your drafts, or your account details. OpenAI processes it to return a safety classification and, per its API terms, does not use it to train its models. Content may also be reported by other users. Anything flagged is reviewed by a moderator, who may hide content that breaks our Terms of Service.

YOUR RIGHTS

• Download: export all your captured process data as JSON at any time from your Profile.
• Delete: permanently delete your captured process data at any time from your Profile.
• Opt out: turn off sharing at any time in your Profile. After opt-out, no new data is recorded to our servers. (Local recording continues only to power your own Human Signal score, and is cleared from your device on opt-out.)
• Account deletion: contact us to remove your account entirely.

DATA RETENTION

We retain process data until you delete it or close your account.

CHANGES TO THIS POLICY

We may update this policy. Material changes will be communicated in-app before they take effect, and you will be asked to re-accept.

CONTACT

hello@inkk.example
`;

export const TERMS_OF_SERVICE = `Inkk Terms of Service
Effective 29 June 2026

By creating an Inkk account or using the service, you agree to these terms.

1. THE SERVICE
Inkk is a writing tool with a "Human Signal" feature that surfaces process information about a piece of writing. Inkk is provided as-is, for personal, lawful use.

2. YOUR ACCOUNT
You are responsible for keeping your account credentials secure. Notify us promptly if your account is compromised.

3. YOUR CONTENT
You own the writing you create on Inkk. By publishing a piece to the Inkk feed, you grant Inkk a non-exclusive licence to display that publication on the platform. We do not claim ownership of your writing.

4. ACCEPTABLE USE
You agree not to use Inkk to publish illegal, harassing, infringing, or otherwise harmful content. Do not attempt to reverse-engineer the Human Signal score, abuse the platform, or scrape other users' data.

5. MODERATION AND REPORTING
Content you publish to the feed and comments you post are screened by an automated moderation service (see the Privacy Policy) and may be reported by other users. We may review, hide, or remove content that violates these terms, and may suspend repeat offenders. You can report content you believe breaks these terms using the report option on a piece or comment.

6. RESEARCH PARTICIPATION
By default, your anonymised writing-process metadata contributes to Inkk's research dataset. The Privacy Policy explains what is and is not collected. You can opt out at any time in your Profile.

7. TERMINATION
You may delete your account at any time. We may suspend or terminate accounts that violate these terms.

8. DISCLAIMERS
Inkk is provided "AS IS" without warranties. The Human Signal score is a heuristic and not a guarantee. We are not liable for losses from outages, data loss, or score inaccuracies.

9. CHANGES
We may update these terms. Continued use after changes constitutes acceptance. Material changes will be communicated in-app before they take effect.

10. CONTACT
hello@inkk.example
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
