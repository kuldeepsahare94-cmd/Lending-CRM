/*
 * Edit a lead — every field, in one popup.
 *
 * Leads are older than the metadata system: name, mobile, email, source,
 * owner and the rest are fixed columns on the `leads` table, and only a
 * handful of later additions (rating, campaign, product interest…) are
 * registered as module fields. So the core fields are declared here, and
 * anything an admin has since added to the Leads module in Settings — custom
 * fields included — is appended from the metadata, so it can't be left out.
 *
 * Section names match the cards on the lead's detail page, so what you edit
 * is laid out the way you read it.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { EditRecordModal } from './RecordEditModal';
import { accentFor } from '../theme/moduleAccents';
import { friendlyError } from './ui';
import { useModuleOptions, allOptions, toOptionsJson } from './fieldOptions';

// Status, Source, Qualification, Rating and Gender options come from
// Settings → Dropdown Options (Leads). These are only the fallback if those
// cannot be read, and are the application's original values.
export const LEAD_STATUSES = ['New', 'Contacted', 'Interested', 'Follow-up', 'Converted', 'Not Interested', 'Dropped'];
const RATINGS = ['Hot', 'Warm', 'Cold'];
const GENDERS = ['Male', 'Female', 'Other'];

const opts = (list) => JSON.stringify(list.filter(Boolean).map((v) => ({ value: v, label: v })));
// A dropdown must always offer the value the record already has — even one
// no longer in the list (a renamed source, a status from an old pipeline) —
// or opening the popup and saving would silently blank it.
const withCurrent = (list, current) => (current && !list.includes(current) ? [current, ...list] : list);

// The leads table's own columns, and which card each one lives on.
const CORE = [
  { section: 'Basic Information', fields: [
    { api_name: 'student_name', label: 'Full Name', field_type: 'text', required: true },
    { api_name: 'account_name', label: 'Company / Account Name', field_type: 'text' },
    { api_name: 'mobile', label: 'Mobile', field_type: 'phone' },
    { api_name: 'alternate_mobile', label: 'Alternate Mobile', field_type: 'phone' },
    { api_name: 'email', label: 'Email', field_type: 'email' },
    { api_name: 'country', label: 'Country', field_type: 'text' },
    { api_name: 'state', label: 'State', field_type: 'text' },
    { api_name: 'city', label: 'City', field_type: 'text' },
    { api_name: 'source', label: 'Source', field_type: 'dropdown', managed: 'source' },
    { api_name: 'assigned_counselor', label: 'Owner', field_type: 'dropdown', dynamic: 'owners' },
    { api_name: 'address', label: 'Address', field_type: 'textarea' },
  ] },
  { section: 'Additional Details', fields: [
    { api_name: 'product_interest', label: 'Product Interest', field_type: 'text' },
    { api_name: 'service_interest', label: 'Service Interest', field_type: 'text' },
    { api_name: 'campaign', label: 'Campaign', field_type: 'text' },
    { api_name: 'lead_rating', label: 'Lead Rating', field_type: 'dropdown', options: RATINGS, managed: 'lead_rating' },
  ] },
  { section: 'Personal Information', fields: [
    { api_name: 'gender', label: 'Gender', field_type: 'dropdown', options: GENDERS, managed: 'gender' },
    { api_name: 'date_of_birth', label: 'Date of Birth', field_type: 'date' },
    { api_name: 'qualification', label: 'Qualification', field_type: 'dropdown', managed: 'qualification' },
  ] },
  // The follow-up is not edited here: it has an exact date AND time and a
  // reminder, and is set from the lead page (Dispose, or the follow-up
  // card's Schedule / Reschedule) — one way to schedule, not two.
  { section: 'Status', fields: [
    { api_name: 'status', label: 'Status', field_type: 'dropdown', options: LEAD_STATUSES, required: true, managed: 'status' },
    { api_name: 'remarks', label: 'Remarks', field_type: 'textarea' },
  ] },
];
const CORE_NAMES = new Set(CORE.flatMap((s) => s.fields.map((f) => f.api_name)));
// Registered in the metadata but not something a person should type into:
// the conversion links are set by converting, and the score is computed.
const NEVER_EDIT = new Set(['lead_score', 'converted_at', 'converted_contact_id', 'converted_account_id', 'converted_opportunity_id', 'follow_up_date']);

export default function LeadEditModal({ leadId, lead: leadIn, focusSection, onClose, onSaved }) {
  const [lead, setLead] = useState(leadIn || null);
  const [meta, setMeta] = useState(null);         // { module, fields }
  const [custom, setCustom] = useState({});
  const [owners, setOwners] = useState([]);
  const managedOptions = useModuleOptions('leads');
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const l = leadIn || await api.getLead(leadId);
        const mod = await api.getModuleMeta('leads').catch(() => null);
        const fields = mod ? await api.listModuleFields(mod.id).catch(() => []) : [];
        const hasCustom = fields.some((f) => !f.is_system && f.show_in_edit);
        const [cv, users] = await Promise.all([
          hasCustom ? api.getCustomFieldValues('leads', leadId).catch(() => ({})) : {},
          // The user list needs users:view, which a sales rep may not have;
          // the chat directory is open to everyone who can chat. Whichever
          // answers — and if neither does, Owner is still a working dropdown
          // holding its current value.
          api.listUsers().catch(() => (api.chatUsers ? api.chatUsers().catch(() => []) : [])),
        ]);
        if (cancelled) return;
        setLead(l);
        setMeta({ module: mod, fields });
        setCustom(cv || {});
        setOwners([...new Set((users || [])
          .filter((u) => u.active !== 0)
          .map((u) => u.full_name || u.name || u.username)
          .filter(Boolean))]);
        setReady(true);
      } catch (e) {
        if (!cancelled) setLoadError(friendlyError(e, 'Could not load this lead.').message);
      }
    })();
    return () => { cancelled = true; };
  }, [leadId]); // eslint-disable-line react-hooks/exhaustive-deps

  const sections = useMemo(() => {
    if (!ready || !lead) return [];
    const out = CORE.map((s) => ({
      key: s.section,
      title: s.section,
      fields: s.fields.map((f) => {
        // Managed options keep their stable values and labels; the form
        // (FieldInput) offers active ones plus whatever the lead already holds.
        if (f.managed && managedOptions?.[f.managed]?.length) {
          return { ...f, options_json: toOptionsJson(allOptions(managedOptions[f.managed])) };
        }
        let list = f.options;
        if (f.dynamic === 'owners') list = owners;
        if (f.managed === 'qualification' && !list) return { ...f, field_type: 'text' };
        if (!list) return f;
        return { ...f, options_json: opts(withCurrent(list, lead[f.api_name])) };
      }),
    }));

    // Anything else configured on the Leads module: extra system fields go on
    // the card named in their `section` (or Additional Details), custom fields
    // on their own card. This is what makes a field added in Settings
    // editable here with no code change.
    const extra = (meta?.fields || []).filter((f) => f.show_in_edit
      && !CORE_NAMES.has(f.api_name) && !NEVER_EDIT.has(f.api_name));
    extra.forEach((f) => {
      const title = f.section && f.section !== 'Details' ? f.section : (f.is_system ? 'Additional Details' : 'More Details');
      let sec = out.find((s) => s.title === title);
      if (!sec) { sec = { key: title, title, fields: [] }; out.splice(out.length - 1, 0, sec); }
      sec.fields.push(f);
    });
    return out;
  }, [ready, lead, meta, managedOptions, owners]);

  const initial = useMemo(() => {
    if (!ready || !lead) return null;
    const v = {};
    sections.forEach((s) => s.fields.forEach((f) => {
      v[f.api_name] = f.is_system === 0 ? custom[f.api_name] : lead[f.api_name];
    }));
    // Stored dates can carry a time ("2026-09-20 00:00:00"); the form works
    // in plain days.
    ['date_of_birth'].forEach((k) => { if (v[k]) v[k] = String(v[k]).slice(0, 10); });
    return v;
  }, [ready, lead, sections, custom]);

  // Only what was actually changed is sent. The lead update merges onto the
  // stored row, and it logs activity and fires automations when status or
  // follow-up date change — re-sending an untouched follow-up date (trimmed
  // to a day for the form) would log a reschedule nobody made.
  const save = async (values, changed) => {
    const touched = new Set(changed);
    const core = {};
    const customPayload = {};
    sections.forEach((s) => s.fields.forEach((f) => {
      if (!touched.has(f.api_name)) return;
      const val = values[f.api_name];
      if (f.is_system === 0) customPayload[f.api_name] = val;
      // Blank means cleared: stored as NULL, not as an empty string that
      // later reads as "has a value".
      else core[f.api_name] = val === '' || val === undefined ? null : val;
    }));
    if (Object.keys(core).length) await api.updateLead(leadId, core);
    if (Object.keys(customPayload).length) await api.saveCustomFieldValues('leads', leadId, customPayload);
    onSaved?.();
  };

  return (
    <EditRecordModal
      title="Edit Lead"
      recordName={lead ? [lead.student_name, lead.account_name].filter(Boolean).join(' · ') : ''}
      accent={accentFor('leads').solid}
      sections={sections}
      initial={initial}
      loading={!ready && !loadError}
      loadError={loadError}
      focusSection={focusSection}
      onSubmit={save}
      onClose={onClose} />
  );
}
