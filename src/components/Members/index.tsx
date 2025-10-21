import type {ReactNode} from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type MemberItem = {
  name: string;
  logo?: string;
  url?: string;
};

const FoundingMembers: MemberItem[] = [
  {
    name: 'Ebiquity',
    logo: '/img/members/ebiquity.png',
  },
  {
    name: 'Optable',
    logo: '/img/members/optable.png',
  },
  {
    name: 'PubMatic',
    logo: '/img/members/pubmatic.png',
  },
  {
    name: 'Scope3',
    logo: '/img/members/scope3-bright.png',
  },
  {
    name: 'Swivel',
    logo: '/img/members/swivel.png',
  },
  {
    name: 'Triton Digital',
    logo: '/img/members/triton-digital.png',
  },
  {
    name: 'Yahoo',
    logo: '/img/members/yahoo-purple.png',
  },
];

const LaunchMembers: MemberItem[] = [
  { name: 'Accuweather' },
  { name: 'Adgent' },
  { name: 'Bidcliq' },
  { name: 'Butler/Till' },
  { name: 'Classify' },
  { name: 'HYPD' },
  { name: 'Kargo' },
  { name: 'Kiln' },
  { name: 'LG Ad Solutions' },
  { name: 'Locala' },
  { name: 'Magnite' },
  { name: 'Media.net' },
  { name: 'MiQ' },
  { name: 'Nativo' },
  { name: 'Newton Research' },
  { name: 'OpenAds' },
  { name: 'Raptive' },
  { name: 'Samba TV' },
  { name: 'Scribd' },
  { name: 'The Product Counsel' },
  { name: 'The Weather Company' },
].sort((a, b) => a.name.localeCompare(b.name));

function Member({name, logo, url}: MemberItem) {
  const content = logo ? (
    <img src={logo} alt={name} className={styles.memberLogo} />
  ) : (
    <span className={styles.memberText}>{name}</span>
  );

  if (url) {
    return (
      <div className={styles.memberItem}>
        <a href={url} target="_blank" rel="noopener noreferrer">
          {content}
        </a>
      </div>
    );
  }

  return <div className={styles.memberItem}>{content}</div>;
}

export function FoundingMembersSection(): ReactNode {
  return (
    <section className={styles.membersSection}>
      <div className="container">
        <Heading as="h2" className="text--center">Founding Members</Heading>
        <div className={styles.memberGrid}>
          {FoundingMembers.map((member, idx) => (
            <Member key={idx} {...member} />
          ))}
        </div>
      </div>
    </section>
  );
}

export function LaunchMembersSection(): ReactNode {
  return (
    <section className={styles.membersSection}>
      <div className="container">
        <Heading as="h2" className="text--center">Launch Members</Heading>
        <div className={styles.launchMemberList}>
          {LaunchMembers.map((member, idx) => (
            <Member key={idx} {...member} />
          ))}
        </div>
      </div>
    </section>
  );
}
