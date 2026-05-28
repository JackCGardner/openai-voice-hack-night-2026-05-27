/**
 * Form — minimal-seed onboarding form rendered inside the Canvas window.
 *
 * Used by P5.3 first-launch onboarding (docs/remaining-phases.md § 5.3):
 *   - projectPath: text input — absolute path to the target project root.
 *   - voice:       select   — Director voice (marin | cedar).
 *   - apiKey:      password — OpenAI API key (stored by main via env or
 *                              keychain, depending on DIRECTOR_USE_KEYCHAIN).
 *
 * Generic enough that other consumers can pass any list of `fields`. The
 * onboarding hook (renderer/src/hooks/useOnboarding.ts) supplies the three
 * field defaults above. The Canvas user_response shape is the field-id →
 * value map, posted via the parent CanvasApp's `onRespond` callback.
 *
 * Pure presentational — no IPC, no store mutations. Submission is delegated
 * to `onSubmit`. Safe to render in tests via ReactDOMServer.
 */

import { useState, type FormEvent, type JSX } from 'react';

export type FormFieldKind = 'text' | 'password' | 'select';

export interface FormField {
  /** Stable id, used as the React key + map key in the submitted payload. */
  id: string;
  /** Visible label above the field. */
  label: string;
  /** Input kind — `text`, `password`, or `select`. */
  kind: FormFieldKind;
  /** Optional placeholder for text/password. */
  placeholder?: string;
  /** Optional default value. */
  defaultValue?: string;
  /** For `select`, the list of options. Ignored otherwise. */
  options?: Array<{ value: string; label: string }>;
  /** When true, the submit button stays disabled until this field is filled. */
  required?: boolean;
}

export interface FormProps {
  /** Optional title rendered as the Canvas eyebrow + heading. */
  title?: string;
  /** Field definitions. Defaults to the onboarding triplet when omitted. */
  fields?: FormField[];
  /** Submit button label. */
  submitLabel?: string;
  /** Called with the field-id → value map when the user submits. */
  onSubmit?: (values: Record<string, string>) => void;
}

const ONBOARDING_FIELDS: FormField[] = [
  {
    id: 'projectPath',
    label: 'Project path',
    kind: 'text',
    placeholder: '/Users/you/code/your-project',
    required: true,
  },
  {
    id: 'voice',
    label: 'Voice',
    kind: 'select',
    defaultValue: 'marin',
    options: [
      { value: 'marin', label: 'Marin' },
      { value: 'cedar', label: 'Cedar' },
    ],
    required: true,
  },
  {
    id: 'apiKey',
    label: 'OpenAI API key',
    kind: 'password',
    placeholder: 'sk-…',
    required: true,
  },
];

export function Form({
  title,
  fields = ONBOARDING_FIELDS,
  submitLabel = 'Save',
  onSubmit,
}: FormProps): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const field of fields) {
      seed[field.id] = field.defaultValue ?? '';
    }
    return seed;
  });

  const setValue = (id: string, v: string): void => {
    setValues((prev) => ({ ...prev, [id]: v }));
  };

  const isComplete = fields.every((field) => {
    if (!field.required) return true;
    const v = values[field.id];
    return typeof v === 'string' && v.trim().length > 0;
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!isComplete) return;
    onSubmit?.({ ...values });
  };

  return (
    <form className="onboard-form" onSubmit={handleSubmit} data-no-drag>
      {title ? <div className="canvas-title">{title}</div> : null}
      <div className="onboard-form-fields">
        {fields.map((field) => (
          <div key={field.id} className="onboard-form-field">
            <label htmlFor={`onboard-${field.id}`}>{field.label}</label>
            {field.kind === 'select' ? (
              <select
                id={`onboard-${field.id}`}
                value={values[field.id] ?? ''}
                onChange={(e) => setValue(field.id, e.target.value)}
              >
                {(field.options ?? []).map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`onboard-${field.id}`}
                type={field.kind === 'password' ? 'password' : 'text'}
                value={values[field.id] ?? ''}
                placeholder={field.placeholder}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setValue(field.id, e.target.value)}
              />
            )}
          </div>
        ))}
      </div>
      <button
        type="submit"
        className="onboard-form-submit"
        disabled={!isComplete}
      >
        {submitLabel}
      </button>
    </form>
  );
}
