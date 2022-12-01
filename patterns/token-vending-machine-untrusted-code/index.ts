import { Construct } from "constructs";
import { CfnOutput, Duration, Stack } from "aws-cdk-lib";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Role, Policy, ServicePrincipal, ArnPrincipal } from "aws-cdk-lib/aws-iam";
import * as iam from "cdk-iam-floyd";

interface TokenVendingMachineRoleConfig {
  readonly principalRoleName: string;
  readonly principalRoleArn: string;
  readonly policyStatements: iam.PolicyStatement[]
}

class TokenVendingMachineRole extends Construct {
  public readonly arn: string;
  public readonly name: string;
  private readonly policyStatements: iam.PolicyStatement[] = [];

  constructor(scope: Construct, id: string, config: TokenVendingMachineRoleConfig) {
    super(scope, id);

    const { principalRoleName, principalRoleArn } = config;
    this.policyStatements = config.policyStatements;

    this.name = `token-vending-machine-${this.node.addr}`.substring(0, 32);
    // const account = Stack.of(this).account

    const tvmRole = new Role(this, "token-vending-machine", {
      roleName: this.name,
      assumedBy: new ArnPrincipal(principalRoleArn),
    });

    this.arn = tvmRole.roleArn;

    // tvmRole.assumeRolePolicy?.addStatements(new iam.Sts()
    //   .allow()
    //   .toAssumeRole()
    //   .toTagSession()
    //   .forRole(account, principalRoleName)
    // )

    tvmRole.attachInlinePolicy(new Policy(this, "token-vending-machine-policy", {
      statements: this.policyStatements
    }));
  }
}

export class TokenVendingMachineUntrustedCode extends Construct {
  public readonly bucket: Bucket;
  public readonly inventory: Table;
  public readonly dispatcher: NodejsFunction;

  constructor(scope: Construct, name: string) {
    super(scope, name);

    const bucket = new Bucket(this, "assets");

    this.bucket = bucket;

    const inventory = new Table(this, "inventory", {
      tableName: `inventory-${this.node.addr}`,
      partitionKey: { name: "PK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST
    })

    this.inventory = inventory

    const target = new NodejsFunction(this, "target", {
      environment: {
        TABLE_NAME: inventory.tableName,
        BUCKET_NAME: bucket.bucketName,
      },
      timeout: Duration.seconds(30),
    });

    const dispatcher = new NodejsFunction(this, "dispatcher", {
      environment: {
        TABLE_ARN: inventory.tableArn,
        BUCKET_ARN: bucket.bucketArn,
        FN_ARN: target.functionArn,
      },
      timeout: Duration.seconds(15)
    });

    target.grantInvoke(dispatcher);

    this.dispatcher = dispatcher

    const role = new TokenVendingMachineRole(this, "role", {
      principalRoleName: dispatcher.role?.roleName!,
      principalRoleArn: dispatcher.role?.roleArn!,
      policyStatements: [
        new iam.S3()
          .allow()
          .toGetObject()
          .on(
            // allow everything on the bucket and scope it down dynamically
            // to a tenant in the Lambda function
            `${bucket.bucketArn}/*`
          ),
        new iam.Dynamodb()
          .allow()
          .toPutItem()
          .toUpdateItem()
          // allow everything on the table and scope it down dynamically
          // to a tenant in the Lambda function
          .on(inventory.tableArn)
      ]
    });


    dispatcher.addEnvironment('TVM_ROLE_ARN', role.name)
  }
}