import type { ListingProfile } from "@/shared/schema";

// ListingProfile summary at extraction.completed (PLAN.md §6). Absent
// optionals simply don't render — absence means "not stated", never "".

function Row({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="profile-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function ProfileCard({ profile }: { profile: ListingProfile }) {
  return (
    <section className="card profile-card" aria-label="Listing profile">
      <header className="profile-head">
        <h2>{profile.company}</h2>
        <p className="profile-role">{profile.role}</p>
      </header>
      <dl className="profile-rows">
        <Row label="Seniority" value={profile.seniority} />
        <Row label="Company domain" value={profile.domain} />
        <Row label="Product area" value={profile.productArea} />
        <Row label="Team signals" value={profile.teamSignals} />
        <Row label="Application contact" value={profile.applicationContact} />
      </dl>
      {profile.namedTechnologies.length > 0 && (
        <ul className="tech-chips" aria-label="Named technologies">
          {profile.namedTechnologies.map((tech) => (
            <li key={tech} className="chip">
              {tech}
            </li>
          ))}
        </ul>
      )}
      {profile.listingUrl && (
        <a className="profile-link" href={profile.listingUrl} target="_blank" rel="noreferrer">
          View listing
        </a>
      )}
    </section>
  );
}
