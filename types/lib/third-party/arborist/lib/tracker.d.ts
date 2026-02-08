export default Tracker;
declare function Tracker(cls: any): {
    new (): {
        [x: string]: any;
        "__#private@#progress": any;
        "__#private@#createTracker"(key: any, name: any): void;
        addTracker(section: any, subsection?: any, key?: any): void;
        finishTracker(section: any, subsection?: any, key?: any): void;
        "__#private@#onError"(msg: any): void;
    };
    [x: string]: any;
};
//# sourceMappingURL=tracker.d.ts.map