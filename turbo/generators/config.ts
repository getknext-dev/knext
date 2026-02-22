import type { PlopTypes } from "@turbo/gen";

export default function generator(plop: PlopTypes.NodePlopAPI): void {
    // A simple generator to create a new Next.js Micro-Frontend (Zone)
    plop.setGenerator("zone", {
        description: "Create a new Next.js Micro-Frontend (Zone) application",
        prompts: [
            {
                type: "input",
                name: "name",
                message: "What is the name of the new zone (e.g., 'zone-b')?",
                validate: (input: string) => {
                    if (input.includes(" ")) {
                        return "Zone name cannot include spaces";
                    }
                    if (!input) {
                        return "Zone name is required";
                    }
                    return true;
                },
            },
        ],
        actions: [
            {
                type: "addMany",
                destination: "{{ turbo.paths.root }}/apps/{{ name }}",
                templateFiles: "templates/zone/**/*.hbs",
                base: "templates/zone",
            },
            // Append the new zone into turbo.json or other routing if necessary natively
            function customAction(answers) {
                // You can run custom CLI logic here if needed
                return "Scaffolded a new Next.js zone at apps/" + (answers as any).name;
            },
        ],
    });

    // Stub for proto generator
    plop.setGenerator("proto", {
        description: "Generate a new gRPC Protobuf definition package",
        prompts: [
            {
                type: "input",
                name: "name",
                message: "What is the name of the proto package?",
            },
        ],
        actions: [
            function (answers) {
                return "Proto generator stub executed for: " + (answers as any).name;
            },
        ],
    });

    // Stub for event generator
    plop.setGenerator("event", {
        description: "Generate a new Knative CloudEvent definition",
        prompts: [
            {
                type: "input",
                name: "name",
                message: "What is the name of the event package?",
            },
        ],
        actions: [
            function (answers) {
                return "Event generator stub executed for: " + (answers as any).name;
            },
        ],
    });
}
