import {
    getChildOfKind,
    getModifier,
    getNextToken,
    getTokenAtPosition,
    hasModifier,
    isClassLikeDeclaration,
    isConstructorDeclaration,
    isParameterProperty
} from 'tsutils';
import * as ts from 'typescript';

import * as Lint from 'tslint';

const OPTION_NO_PUBLIC = 'no-public';
const OPTION_CHECK_ACCESSOR = 'check-accessor';
const OPTION_CHECK_CONSTRUCTOR = 'check-constructor';
const OPTION_CHECK_PARAMETER_PROPERTY = 'check-parameter-property';
const OPTION_IGNORE_ANGULAR_LIFECYCLE = 'ignore-angular-lifecycle';

interface Options {
    noPublic: boolean;
    checkAccessor: boolean;
    checkConstructor: boolean;
    checkParameterProperty: boolean;
    ignoreAngularLifecycleProperty: boolean;
}

export class Rule extends Lint.Rules.AbstractRule {
    /* tslint:disable:object-literal-sort-keys */
    public static metadata: Lint.IRuleMetadata = {
        ruleName: 'member-access',
        description: 'Requires explicit visibility declarations for class members.',
        rationale: Lint.Utils.dedent`
            Explicit visibility declarations can make code more readable and accessible for those new to TS.
            Other languages such as C# default to \`private\`, unlike TypeScript's default of \`public\`.
            Members lacking a visibility declaration may be an indication of an accidental leak of class internals.
        `,
        optionsDescription: Lint.Utils.dedent`
            These arguments may be optionally provided:
            * \`"no-public"\` forbids public accessibility to be specified, because this is the default.
            * \`"check-accessor"\` enforces explicit visibility on get/set accessors
            * \`"check-constructor"\`  enforces explicit visibility on constructors
            * \`"check-parameter-property"\`  enforces explicit visibility on parameter properties
            * \`"ignore-angular-lifecycle"\`  ignores the angular lifecycle hooks when requiring member access`,
        options: {
            type: 'array',
            items: {
                type: 'string',
                enum: [
                    OPTION_NO_PUBLIC,
                    OPTION_CHECK_ACCESSOR,
                    OPTION_CHECK_CONSTRUCTOR,
                    OPTION_CHECK_PARAMETER_PROPERTY,
                    OPTION_IGNORE_ANGULAR_LIFECYCLE
                ]
            },
            minLength: 0,
            maxLength: 5
        },
        optionExamples: [true, [true, OPTION_NO_PUBLIC], [true, OPTION_CHECK_ACCESSOR]],
        type: 'typescript',
        typescriptOnly: true,
        hasFix: true
    };
    /* tslint:enable:object-literal-sort-keys */

    public static FAILURE_STRING_NO_PUBLIC: string = "'public' is implicit.";

    public static FAILURE_STRING_FACTORY(
        memberType: string,
        memberName: string | undefined
    ): string {
        memberName = memberName === undefined ? '' : ` '${memberName}'`;
        return `The ${memberType}${memberName} must be marked either 'private', 'public', or 'protected'`;
    }

    public apply(sourceFile: ts.SourceFile): Lint.RuleFailure[] {
        const options = this.ruleArguments;
        const noPublic = options.indexOf(OPTION_NO_PUBLIC) !== -1;
        let checkAccessor = options.indexOf(OPTION_CHECK_ACCESSOR) !== -1;
        let checkConstructor = options.indexOf(OPTION_CHECK_CONSTRUCTOR) !== -1;
        let checkParameterProperty = options.indexOf(OPTION_CHECK_PARAMETER_PROPERTY) !== -1;
        const ignoreAngularLifecycleProperty =
            options.indexOf(OPTION_IGNORE_ANGULAR_LIFECYCLE) !== -1;
        if (noPublic) {
            if (checkAccessor || checkConstructor || checkParameterProperty) {
                return [];
            }
            checkAccessor = checkConstructor = checkParameterProperty = true;
        }
        return this.applyWithFunction(sourceFile, walk, {
            checkAccessor,
            checkConstructor,
            checkParameterProperty,
            noPublic,
            ignoreAngularLifecycleProperty
        });
    }
}

function walk(ctx: Lint.WalkContext<Options>): void {
    const {
        noPublic,
        checkAccessor,
        checkConstructor,
        checkParameterProperty,
        ignoreAngularLifecycleProperty
    } = ctx.options;
    const angularLifecycleProperties = [
        'ngOnChanges',
        'ngOnInit',
        'ngDoCheck',
        'ngAfterContentInit',
        'ngAfterContentChecked',
        'ngAfterViewInit',
        'ngAfterViewChecked',
        'ngOnDestroy'
    ];
    return ts.forEachChild(ctx.sourceFile, function recur(node: ts.Node): void {
        if (isClassLikeDeclaration(node)) {
            for (const child of node.members) {
                if (shouldCheck(child)) {
                    check(child);
                }
                if (
                    checkParameterProperty &&
                    isConstructorDeclaration(child) &&
                    child.body !== undefined
                ) {
                    for (const param of child.parameters) {
                        if (isParameterProperty(param)) {
                            check(param);
                        }
                    }
                }
            }
        }
        return ts.forEachChild(node, recur);
    });

    function shouldCheck(node: ts.ClassElement): boolean {
        switch (node.kind) {
            case ts.SyntaxKind.Constructor:
                return checkConstructor;
            case ts.SyntaxKind.GetAccessor:
            case ts.SyntaxKind.SetAccessor:
                return checkAccessor;
            case ts.SyntaxKind.MethodDeclaration:
            case ts.SyntaxKind.PropertyDeclaration:
                return true;
            default:
                return false;
        }
    }

    function check(node: ts.ClassElement | ts.ParameterDeclaration): void {
        if (
            hasModifier(
                node.modifiers,
                ts.SyntaxKind.ProtectedKeyword,
                ts.SyntaxKind.PrivateKeyword
            )
        ) {
            return;
        }
        const publicKeyword = getModifier(node, ts.SyntaxKind.PublicKeyword);
        if (noPublic && publicKeyword !== undefined) {
            // public is not optional for parameter property without the readonly modifier
            if (
                node.kind !== ts.SyntaxKind.Parameter ||
                hasModifier(node.modifiers, ts.SyntaxKind.ReadonlyKeyword)
            ) {
                const start = publicKeyword.end - 'public'.length;
                ctx.addFailure(
                    start,
                    publicKeyword.end,
                    Rule.FAILURE_STRING_NO_PUBLIC,
                    Lint.Replacement.deleteFromTo(
                        start,
                        getNextToken(publicKeyword, ctx.sourceFile)!.getStart(ctx.sourceFile)
                    )
                );
            }
        }
        if (!noPublic && publicKeyword === undefined) {
            const nameNode =
                node.kind === ts.SyntaxKind.Constructor
                    ? getChildOfKind(node, ts.SyntaxKind.ConstructorKeyword, ctx.sourceFile)!
                    : node.name !== undefined
                    ? node.name
                    : node;
            const memberName =
                node.name !== undefined && node.name.kind === ts.SyntaxKind.Identifier
                    ? node.name.text
                    : undefined;
            if (
                ignoreAngularLifecycleProperty &&
                angularLifecycleProperties.indexOf(memberName) > -1
            ) {
                // Ignore error
            } else {
                ctx.addFailureAtNode(
                    nameNode,
                    Rule.FAILURE_STRING_FACTORY(typeToString(node), memberName),
                    Lint.Replacement.appendText(
                        getInsertionPosition(node, ctx.sourceFile),
                        'public '
                    )
                );
            }
        }
    }
}

function getInsertionPosition(
    member: ts.ClassElement | ts.ParameterDeclaration,
    sourceFile: ts.SourceFile
): number {
    const node =
        member.decorators === undefined
            ? member
            : getTokenAtPosition(member, member.decorators.end, sourceFile)!;
    return node.getStart(sourceFile);
}

function typeToString(node: ts.ClassElement | ts.ParameterDeclaration): string {
    switch (node.kind) {
        case ts.SyntaxKind.MethodDeclaration:
            return 'class method';
        case ts.SyntaxKind.PropertyDeclaration:
            return 'class property';
        case ts.SyntaxKind.Constructor:
            return 'class constructor';
        case ts.SyntaxKind.GetAccessor:
            return 'get property accessor';
        case ts.SyntaxKind.SetAccessor:
            return 'set property accessor';
        case ts.SyntaxKind.Parameter:
            return 'parameter property';
        default:
            throw new Error(`unhandled node type ${ts.SyntaxKind[node.kind]}`);
    }
}
