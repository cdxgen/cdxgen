/**
 * Conversions between the 1.x organizational entities and contacts and the
 * CycloneDX 2.0 parties (#/$defs/cyclonedx-party-2.0) and common entities
 * (#/$defs/cyclonedx-common-2.0).
 */
/**
 * A person party playing `role` for a 1.x contact. The contact's `bom-ref`
 * is the party's refId (#/$defs/cyclonedx-party-2.0/$defs/party).
 *
 * @param {object|string} contact 1.x organizationalContact
 * @param {string} role Predefined role
 * @param {object} stats Render counters
 * @returns {object|undefined} 2.0 party
 */
export declare function contactToParty(contact: object | string, role: string, stats: object): object | undefined;
/**
 * Convert a 1.x organizationalEntity into 2.0 parties playing `role`
 * (#/$defs/cyclonedx-party-2.0/$defs/party, required `[roles]`, exactly one
 * identity sub-shape). The organization
 * (#/$defs/cyclonedx-party-2.0/$defs/organization) takes `url` as
 * `[{url}]` and `addresses` as an array and has no `bom-ref` or `contact`, so
 * every 1.x contact becomes its own person party with the same role.
 */
export declare function entityToParties(entity: any, role: any, stats: any): object[];
/**
 * Convert a 1.x organizationalContact to the 2.0 common organizationalContact
 * (#/$defs/cyclonedx-common-2.0/$defs/organizationalContact), which renames
 * `bom-ref` to `refId`. Used by metadata authors and annotators.
 */
export declare function toCommonContact(contact: any, stats: any): {
    name: any;
} | {
    refId: any;
} | undefined;
/**
 * Convert a 1.x organizationalEntity to the 2.0 common organizationalEntity
 * (#/$defs/cyclonedx-common-2.0/$defs/organizationalEntity), used by
 * metadata.supplier, metadata.manufacturer and annotator.organization. It
 * keeps `url` strings and `contact`, and renames `bom-ref` to `refId`.
 */
export declare function toCommonEntity(entity: any, stats: any): {
    refId: any;
    name: any;
    address: {
        refId: any;
    };
    url: any[];
    contact: any;
} | undefined;
/**
 * Convert the 1.x party-ish component fields into `parties`
 * (#/$defs/cyclonedx-party-2.0/$defs/party). `author` strings and `authors`
 * contacts become persons with the `author` role, `publisher` an organization
 * with the `publisher` role, and supplier/manufacturer organizations keep
 * their roles.
 */
export declare function collectParties(component: any, stats: any): object[];
/**
 * Read 2.0 component or service `parties` into the 1.x fields
 * (`supplier`, `manufacturer`, `authors`, `publisher`, `provider`). A person
 * playing the supplier, manufacturer or provider role becomes a contact of
 * that organization, the inverse of entityToParties. Party references resolve
 * against definitions.parties. Everything else is a loss.
 *
 * @param {object} ctx Reader context
 * @param {Array} parties 2.0 parties
 * @param {string} pointer JSON pointer of `parties`
 * @param {object} roleFields Roles to read (subset of PARTY_ROLE_FIELDS_1X)
 * @returns {object} 1.x fields by name
 */
export declare function reverseParties(ctx: object, parties: any[], pointer: string, roleFields: object): object;
/**
 * Read one 2.0 party (inline or a partyReference) whose roles `roleFields`
 * lists: its roles, the 1.x organization or contact it describes, and the
 * pointer of the party object. Unlisted roles and members are losses.
 *
 * @param {object} ctx Reader context
 * @param {object} entry 2.0 party or partyReference
 * @param {string} pointer JSON pointer of `entry`
 * @param {object} roleFields Role names to read, as keys
 * @returns {{roles: string[], identity: {kind: string, identity: object}, pointer: string}|undefined}
 */
export declare function readParty(ctx: object, entry: object, pointer: string, roleFields: object): {
    roles: string[];
    identity: {
        kind: string;
        identity: object;
    };
    pointer: string;
} | undefined;
//# sourceMappingURL=cyclonedx20Parties.d.ts.map