/**
 * Render-side conversion of 1.x components, services and tools to CycloneDX
 * 2.0 components (#/$defs/cyclonedx-component-2.0/$defs/component).
 */
/**
 * Convert license choices: 1.x license objects and expressions may carry
 * `bom-ref`, which the 2.0 licenseDeclaration renames to `refId`
 * (#/$defs/cyclonedx-license-2.0/$defs/licenseDeclaration).
 */
export declare function convertLicenses(licenses: any): any[] | undefined;
/**
 * Convert one 1.x component to the 2.0 component shape
 * (#/$defs/cyclonedx-component-2.0/$defs/component). Fields with no 2.0
 * home (`signature`, the deprecated `modified`, …) are counted.
 */
export declare function convertComponent(component: any, stats: any): any;
/**
 * Convert one 1.x service into a 2.0 component of type `service`
 * (#/$defs/cyclonedx-component-2.0/$defs/component/properties/type). The
 * provider becomes a party with the `provider` role. `authenticated`,
 * `x-trust-boundary` and `trustZone` have no 2.0 field; they ride as the
 * cdx:service:* properties of CARRIED_SERVICE_PROPERTIES, after the service's
 * own properties, and the reader turns them back into the 1.x fields.
 */
export declare function convertService(service: any, stats: any): any;
/**
 * Convert metadata.tools: the 1.x {components, services} object, or the
 * legacy 1.5 array. 2.0 tools hold only `components`
 * (#/$defs/cyclonedx-metadata-2.0/$defs/metadata/properties/tools).
 */
export declare function convertTools(tools: any, stats: any): {
    components: any[];
} | undefined;
//# sourceMappingURL=cyclonedx20RenderComponents.d.ts.map