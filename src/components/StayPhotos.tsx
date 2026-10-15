"use client";

import Image, { type StaticImageData } from "next/image";
import { useState } from "react";

import algarveShore from "../../public/images/stays/coast-algarve-shore.jpg";
import gocekEvening from "../../public/images/stays/coast-gocek-evening.jpg";
import gokovaBay from "../../public/images/stays/coast-gokova-bay.jpg";
import lagosBeach from "../../public/images/stays/coast-lagos-beach.jpg";
import lagosCliffs from "../../public/images/stays/coast-lagos-cliffs.jpg";
import poolGarden from "../../public/images/stays/pool-garden-infinity.jpg";
import poolHillside from "../../public/images/stays/pool-hillside-infinity.jpg";
import poolTerrace from "../../public/images/stays/pool-terrace.jpg";
import roomBedroom from "../../public/images/stays/room-bedroom.jpg";
import roomBreakfast from "../../public/images/stays/room-breakfast.jpg";

/*
 * Representative photos for a listing.
 *
 * Never the resort or the unit: those are in the ownership record, which is not
 * published, and a photo of the real place would publish it by other means. So a
 * week gets pictures of the kind of place it is in — its country's coast, a pool
 * if it has one, a room — picked from a fixed set by what the issuer attested, and
 * labelled as representative wherever they appear. Credits: public/images/CREDITS.md.
 */
type Photo = { src: StaticImageData; alt: string; credit: string };

const COAST_PT: Photo[] = [
  { src: lagosBeach, alt: "A sandy cove between sea stacks on the Algarve coast", credit: "João Paulo F. Barreiros, public domain" },
  { src: lagosCliffs, alt: "Golden sea cliffs rising from calm water", credit: "Glen Bowman, CC BY 2.0" },
  { src: algarveShore, alt: "A quiet beach with palms beside a seafront walk", credit: "Dronepicr, CC BY 3.0" },
];
const COAST_TR: Photo[] = [
  { src: gokovaBay, alt: "Sailing boats moored in a bay ringed by mountains", credit: "Semih Ekinci, CC BY-SA 3.0" },
  { src: gocekEvening, alt: "Evening light over a harbour among wooded hills", credit: "Poet Laureate, CC BY 2.0" },
];
const POOLS: Photo[] = [
  { src: poolGarden, alt: "An infinity pool on a lawn between palm trees, facing the sea", credit: "Jayen466, public domain" },
  { src: poolHillside, alt: "An infinity pool above green hills and a bay", credit: "Cosmic Timetraveler, CC0" },
  { src: poolTerrace, alt: "A round pool on a terrace with loungers by the sea", credit: "Dario Dominico, CC BY 3.0" },
];
const ROOMS: Photo[] = [
  { src: roomBedroom, alt: "A bright double bedroom with tall curtained windows", credit: "Markus Spiske, CC0" },
  { src: roomBreakfast, alt: "Breakfast on a tray in bed", credit: "Toa Heftiba, CC0" },
];

function rotate<T>(list: T[], by: number): T[] {
  const k = by % list.length;
  return [...list.slice(k), ...list.slice(0, k)];
}

/** Four photos for a week: its coast first (the cover), then pool, room, more coast. */
export function photosFor(id: number, region: string | null, features: string[] = []): Photo[] {
  const place = (region ?? "").toLowerCase();
  const coast =
    /portugal/.test(place) ? COAST_PT
    : /turkey|türkiye|turkiye/.test(place) ? COAST_TR
    : [...COAST_PT, ...COAST_TR];
  const hasPool = features.some((f) => /pool/i.test(f));
  const coasts = rotate(coast, id);
  return [
    ...coasts.slice(0, 1),
    ...(hasPool ? rotate(POOLS, id).slice(0, 1) : []),
    ...rotate(ROOMS, id).slice(0, 1),
    ...coasts.slice(1, hasPool ? 2 : 3),
  ];
}

/** The card's cover: one photo, labelled, with a count that opens the gallery. */
export function StayCover({ photos, onOpen }: { photos: Photo[]; onOpen: () => void }) {
  const cover = photos[0];
  if (cover === undefined) return null;
  return (
    <button type="button" className="stay-cover" onClick={onOpen} aria-label="Show photos and details">
      <Image src={cover.src} alt={cover.alt} placeholder="blur" sizes="(max-width: 700px) 100vw, 420px" />
      <span className="stay-badge">Representative photo</span>
      <span className="stay-count">{photos.length} photos · details</span>
    </button>
  );
}

/** The opened card's gallery: one large photo, thumbnails to change it, a credit. */
export function StayGallery({ photos }: { photos: Photo[] }) {
  const [shown, setShown] = useState(0);
  const photo = photos[shown] ?? photos[0];
  if (photo === undefined) return null;
  return (
    <figure className="stay-gallery">
      <div className="stay-stage">
        <Image key={shown} src={photo.src} alt={photo.alt} placeholder="blur" sizes="(max-width: 900px) 100vw, 760px" />
        <span className="stay-badge">Representative photos — not this resort</span>
      </div>
      <div className="stay-thumbs" role="tablist" aria-label="Photos">
        {photos.map((p, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === shown}
            aria-label={`Photo ${i + 1} of ${photos.length}`}
            onClick={() => setShown(i)}
          >
            <Image src={p.src} alt="" sizes="120px" />
          </button>
        ))}
      </div>
      <figcaption className="muted">
        {photo.alt}. Photo: {photo.credit}, via Wikimedia Commons. The resort and unit are in the
        unpublished ownership record; these show the kind of place, not the place.
      </figcaption>
    </figure>
  );
}
