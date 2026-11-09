import type { Contact } from '@sim/contracts/servicenow';
import { cn, StatusBadge, UserAvatar } from '@sim/ui';
import { Mail, Phone } from 'lucide-react';
import { Link } from 'react-router';
import { refLinkClass } from './bits';

/** Person card with phone and email, used for on-call rotas and managers. */
export function ContactCard({ person, label }: { person: Contact; label: string }) {
  return (
    <div className="flex items-start gap-3 rounded-(--radius) border bg-card p-3 text-[13px]">
      <UserAvatar name={person.name} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <Link
            to={`/users/${person.username}`}
            className={cn('truncate font-semibold', refLinkClass)}
          >
            {person.name}
          </Link>
          <StatusBadge tone={label === 'Primary' ? 'positive' : 'neutral'}>{label}</StatusBadge>
        </div>
        <div className="truncate text-muted-foreground">{person.title}</div>
        <div className="mt-1.5 flex flex-col gap-0.5 text-muted-foreground">
          <span className="flex items-center gap-1.5 tabular-nums">
            <Phone className="size-3.5" />
            {person.phone}
          </span>
          <a
            href={`mailto:${person.email}`}
            className="flex items-center gap-1.5 truncate hover:text-link"
          >
            <Mail className="size-3.5" />
            {person.email}
          </a>
        </div>
      </div>
    </div>
  );
}
