'use strict'

/**
 * Xcode project.pbxproj generator.
 *
 * Generates a valid project.pbxproj from a directory of Swift source files.
 * Works for any macOS/iOS SwiftUI project — scans the source directory,
 * builds file references, groups, build phases, and targets automatically.
 *
 * Usage:
 *   const { generateXcodeProject } = require('./xcode-project-gen')
 *   const result = generateXcodeProject({
 *     projectDir: '/path/to/MyApp',
 *     productName: 'MyApp',
 *     orgIdentifier: 'com.example',
 *     platform: 'macos',          // 'macos' | 'ios'
 *     deploymentTarget: '14.0',
 *     sourceDir: 'MyApp',         // relative to projectDir
 *   })
 *   // result.pbxproj — the file content
 *   // result.written — true if written to disk
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

// ── UUID generation ───────────────────────────────────────────────────────────
// pbxproj uses 24-char uppercase hex IDs. We use deterministic hashing so
// regenerating the same project produces the same UUIDs (diffable).
function pbxUUID(seed) {
  return crypto.createHash('md5').update(seed).digest('hex')
    .slice(0, 24).toUpperCase()
}

// ── File scanner ──────────────────────────────────────────────────────────────
function scanSourceDir(sourceRoot) {
  const swift = []
  const xcassets = []
  const plists = []
  const storyboards = []
  const xibs = []
  const resources = []

  function walk(dir, rel) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
    catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'build') continue
      const full = path.join(dir, e.name)
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.name.endsWith('.xcassets')) {
          xcassets.push(relPath)
        } else if (e.name.endsWith('.lproj')) {
          // Localization bundles — treat as resources
          resources.push(relPath)
        } else {
          walk(full, relPath)
        }
      } else if (e.name.endsWith('.swift')) {
        swift.push(relPath)
      } else if (e.name.endsWith('.plist')) {
        plists.push(relPath)
      } else if (e.name.endsWith('.storyboard')) {
        storyboards.push(relPath)
      } else if (e.name.endsWith('.xib')) {
        xibs.push(relPath)
      } else if (/\.(json|png|jpg|jpeg|svg|ttf|otf|wav|mp3|mp4|mov|metal)$/i
        .test(e.name)) {
        resources.push(relPath)
      }
    }
  }

  walk(sourceRoot, '')
  return { swift, xcassets, plists, storyboards, xibs, resources }
}

// ── Group tree builder ────────────────────────────────────────────────────────
// Builds a nested group structure mirroring the directory layout.
function buildGroupTree(files, prefix) {
  const tree = { children: new Map(), files: [] }
  for (const f of files) {
    const parts = f.split('/')
    let node = tree
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.children.has(parts[i])) {
        node.children.set(parts[i], { children: new Map(), files: [] })
      }
      node = node.children.get(parts[i])
    }
    node.files.push(f)
  }
  return tree
}

// ── pbxproj generator ─────────────────────────────────────────────────────────
function generateXcodeProject(opts = {}) {
  const {
    projectDir,
    productName = 'App',
    orgIdentifier = 'com.developer',
    platform = 'macos',
    deploymentTarget = '14.0',
    sourceDir,
    teamId = '',
  } = opts

  if (!projectDir || !fs.existsSync(projectDir)) {
    return { error: `Project directory not found: ${projectDir}` }
  }

  // Resolve source directory
  const srcDirName = sourceDir || productName
  const srcRoot = path.join(projectDir, srcDirName)
  if (!fs.existsSync(srcRoot)) {
    return { error: `Source directory not found: ${srcRoot}` }
  }

  const files = scanSourceDir(srcRoot)
  if (files.swift.length === 0) {
    return { error: `No Swift files found in ${srcRoot}` }
  }

  const bundleId = `${orgIdentifier}.${productName}`

  // ── Generate UUIDs for all objects ──────────────────────────────────
  const projectUUID = pbxUUID(`project:${productName}`)
  const rootGroupUUID = pbxUUID(`group:root:${productName}`)
  const mainGroupUUID = pbxUUID(`group:main:${srcDirName}`)
  const productsGroupUUID = pbxUUID(`group:Products`)
  const targetUUID = pbxUUID(`target:${productName}`)
  const configListProjectUUID = pbxUUID(`configList:project:${productName}`)
  const configListTargetUUID = pbxUUID(`configList:target:${productName}`)
  const configDebugProjectUUID = pbxUUID(`config:debug:project:${productName}`)
  const configReleaseProjectUUID = pbxUUID(`config:release:project:${productName}`)
  const configDebugTargetUUID = pbxUUID(`config:debug:target:${productName}`)
  const configReleaseTargetUUID = pbxUUID(`config:release:target:${productName}`)
  const sourcesBuildPhaseUUID = pbxUUID(`phase:sources:${productName}`)
  const resourcesBuildPhaseUUID = pbxUUID(`phase:resources:${productName}`)
  const frameworksBuildPhaseUUID = pbxUUID(`phase:frameworks:${productName}`)
  const productRefUUID = pbxUUID(`product:${productName}`)

  // File references and build files
  const fileRefs = []    // { uuid, buildUuid, path, name, type, lastKnownFileType }
  const buildFiles = []  // { uuid, fileRefUuid, name }
  const resourceBuildFiles = []

  // Swift sources
  for (const f of files.swift) {
    const uuid = pbxUUID(`fileRef:${f}`)
    const buildUuid = pbxUUID(`buildFile:${f}`)
    const name = path.basename(f)
    fileRefs.push({ uuid, path: f, name, lastKnownFileType: 'sourcecode.swift' })
    buildFiles.push({ uuid: buildUuid, fileRefUuid: uuid, name })
  }

  // Asset catalogs
  for (const f of files.xcassets) {
    const uuid = pbxUUID(`fileRef:${f}`)
    const buildUuid = pbxUUID(`buildFile:resource:${f}`)
    const name = path.basename(f)
    fileRefs.push({ uuid, path: f, name, lastKnownFileType: 'folder.assetcatalog' })
    resourceBuildFiles.push({ uuid: buildUuid, fileRefUuid: uuid, name })
  }

  // Storyboards
  for (const f of files.storyboards) {
    const uuid = pbxUUID(`fileRef:${f}`)
    const buildUuid = pbxUUID(`buildFile:resource:${f}`)
    const name = path.basename(f)
    fileRefs.push({ uuid, path: f, name, lastKnownFileType: 'file.storyboard' })
    resourceBuildFiles.push({ uuid: buildUuid, fileRefUuid: uuid, name })
  }

  // ── Build group hierarchy ──────────────────────────────────────────
  const allFiles = [...files.swift, ...files.xcassets, ...files.storyboards]
  const groupTree = buildGroupTree(allFiles, srcDirName)

  // Flatten groups into PBXGroup entries
  const groups = []
  function flattenGroups(node, groupName, parentSeed) {
    const seed = `${parentSeed}/${groupName}`
    const uuid = pbxUUID(`group:${seed}`)
    const childUUIDs = []

    // Sub-groups
    for (const [name, child] of node.children) {
      const childUuid = flattenGroups(child, name, seed)
      childUUIDs.push(childUuid)
    }

    // Files in this group
    for (const f of node.files) {
      const ref = fileRefs.find(r => r.path === f)
      if (ref) childUUIDs.push(ref.uuid)
    }

    groups.push({ uuid, name: groupName, children: childUUIDs, path: groupName })
    return uuid
  }

  const mainGroupChildUUID = flattenGroups(groupTree, srcDirName, 'root')

  // Product type
  const isIOS = platform === 'ios'
  const productType = isIOS
    ? 'com.apple.product-type.application'
    : 'com.apple.product-type.application'
  const sdkRoot = isIOS ? 'iphoneos' : 'macosx'
  const deploymentTargetKey = isIOS
    ? 'IPHONEOS_DEPLOYMENT_TARGET'
    : 'MACOSX_DEPLOYMENT_TARGET'
  const productExt = '.app'

  // ── Render pbxproj ─────────────────────────────────────────────────
  let out = ''
  out += '// !$*UTF8*$!\n'
  out += '{\n'
  out += '\tarchiveVersion = 1;\n'
  out += '\tclasses = {\n\t};\n'
  out += '\tobjectVersion = 56;\n'
  out += '\tobjects = {\n\n'

  // PBXBuildFile
  out += '/* Begin PBXBuildFile section */\n'
  for (const bf of buildFiles) {
    out += `\t\t${bf.uuid} /* ${bf.name} in Sources */ = {isa = PBXBuildFile; fileRef = ${bf.fileRefUuid} /* ${bf.name} */; };\n`
  }
  for (const bf of resourceBuildFiles) {
    out += `\t\t${bf.uuid} /* ${bf.name} in Resources */ = {isa = PBXBuildFile; fileRef = ${bf.fileRefUuid} /* ${bf.name} */; };\n`
  }
  out += '/* End PBXBuildFile section */\n\n'

  // PBXFileReference
  out += '/* Begin PBXFileReference section */\n'
  for (const fr of fileRefs) {
    // Use just the filename for path — the parent PBXGroup already provides
    // the directory path. Using the full relative path here causes Xcode to
    // double up: group.path + fileRef.path = "Models/Models/Cluster.swift".
    out += `\t\t${fr.uuid} /* ${fr.name} */ = {isa = PBXFileReference; lastKnownFileType = ${fr.lastKnownFileType}; path = "${fr.name}"; sourceTree = "<group>"; };\n`
  }
  // Product reference
  out += `\t\t${productRefUUID} /* ${productName}${productExt} */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = "${productName}${productExt}"; sourceTree = BUILT_PRODUCTS_DIR; };\n`
  out += '/* End PBXFileReference section */\n\n'

  // PBXFrameworksBuildPhase
  out += '/* Begin PBXFrameworksBuildPhase section */\n'
  out += `\t\t${frameworksBuildPhaseUUID} /* Frameworks */ = {\n`
  out += '\t\t\tisa = PBXFrameworksBuildPhase;\n'
  out += '\t\t\tbuildActionMask = 2147483647;\n'
  out += '\t\t\tfiles = (\n\t\t\t);\n'
  out += '\t\t\trunOnlyForDeploymentPostprocessing = 0;\n'
  out += '\t\t};\n'
  out += '/* End PBXFrameworksBuildPhase section */\n\n'

  // PBXGroup
  out += '/* Begin PBXGroup section */\n'
  // Root group
  out += `\t\t${rootGroupUUID} = {\n`
  out += '\t\t\tisa = PBXGroup;\n'
  out += '\t\t\tchildren = (\n'
  out += `\t\t\t\t${mainGroupChildUUID} /* ${srcDirName} */,\n`
  out += `\t\t\t\t${productsGroupUUID} /* Products */,\n`
  out += '\t\t\t);\n'
  out += '\t\t\tsourceTree = "<group>";\n'
  out += '\t\t};\n'
  // Products group
  out += `\t\t${productsGroupUUID} /* Products */ = {\n`
  out += '\t\t\tisa = PBXGroup;\n'
  out += '\t\t\tchildren = (\n'
  out += `\t\t\t\t${productRefUUID} /* ${productName}${productExt} */,\n`
  out += '\t\t\t);\n'
  out += '\t\t\tname = Products;\n'
  out += '\t\t\tsourceTree = "<group>";\n'
  out += '\t\t};\n'
  // Source groups
  for (const g of groups) {
    out += `\t\t${g.uuid} /* ${g.name} */ = {\n`
    out += '\t\t\tisa = PBXGroup;\n'
    out += '\t\t\tchildren = (\n'
    for (const c of g.children) {
      out += `\t\t\t\t${c},\n`
    }
    out += '\t\t\t);\n'
    out += `\t\t\tpath = "${g.path}";\n`
    out += '\t\t\tsourceTree = "<group>";\n'
    out += '\t\t};\n'
  }
  out += '/* End PBXGroup section */\n\n'

  // PBXNativeTarget
  out += '/* Begin PBXNativeTarget section */\n'
  out += `\t\t${targetUUID} /* ${productName} */ = {\n`
  out += '\t\t\tisa = PBXNativeTarget;\n'
  out += `\t\t\tbuildConfigurationList = ${configListTargetUUID} /* Build configuration list for PBXNativeTarget "${productName}" */;\n`
  out += '\t\t\tbuildPhases = (\n'
  out += `\t\t\t\t${sourcesBuildPhaseUUID} /* Sources */,\n`
  out += `\t\t\t\t${frameworksBuildPhaseUUID} /* Frameworks */,\n`
  out += `\t\t\t\t${resourcesBuildPhaseUUID} /* Resources */,\n`
  out += '\t\t\t);\n'
  out += '\t\t\tbuildRules = (\n\t\t\t);\n'
  out += '\t\t\tdependencies = (\n\t\t\t);\n'
  out += `\t\t\tname = ${productName};\n`
  out += `\t\t\tproductName = ${productName};\n`
  out += `\t\t\tproductReference = ${productRefUUID} /* ${productName}${productExt} */;\n`
  out += `\t\t\tproductType = "${productType}";\n`
  out += '\t\t};\n'
  out += '/* End PBXNativeTarget section */\n\n'

  // PBXProject
  out += '/* Begin PBXProject section */\n'
  out += `\t\t${projectUUID} /* Project object */ = {\n`
  out += '\t\t\tisa = PBXProject;\n'
  out += '\t\t\tattributes = {\n'
  out += '\t\t\t\tBuildIndependentTargetsInParallel = 1;\n'
  out += '\t\t\t\tLastSwiftUpdateCheck = 1540;\n'
  out += '\t\t\t\tLastUpgradeCheck = 1540;\n'
  out += '\t\t\t};\n'
  out += `\t\t\tbuildConfigurationList = ${configListProjectUUID};\n`
  out += '\t\t\tcompatibilityVersion = "Xcode 14.0";\n'
  out += '\t\t\tdevelopmentRegion = en;\n'
  out += '\t\t\thasScannedForEncodings = 0;\n'
  out += '\t\t\tknownRegions = (\n\t\t\t\ten,\n\t\t\t\tBase,\n\t\t\t);\n'
  out += `\t\t\tmainGroup = ${rootGroupUUID};\n`
  out += `\t\t\tproductRefGroup = ${productsGroupUUID} /* Products */;\n`
  out += '\t\t\tprojectDirPath = "";\n'
  out += '\t\t\tprojectRoot = "";\n'
  out += '\t\t\ttargets = (\n'
  out += `\t\t\t\t${targetUUID} /* ${productName} */,\n`
  out += '\t\t\t);\n'
  out += '\t\t};\n'
  out += '/* End PBXProject section */\n\n'

  // PBXResourcesBuildPhase
  out += '/* Begin PBXResourcesBuildPhase section */\n'
  out += `\t\t${resourcesBuildPhaseUUID} /* Resources */ = {\n`
  out += '\t\t\tisa = PBXResourcesBuildPhase;\n'
  out += '\t\t\tbuildActionMask = 2147483647;\n'
  out += '\t\t\tfiles = (\n'
  for (const bf of resourceBuildFiles) {
    out += `\t\t\t\t${bf.uuid} /* ${bf.name} in Resources */,\n`
  }
  out += '\t\t\t);\n'
  out += '\t\t\trunOnlyForDeploymentPostprocessing = 0;\n'
  out += '\t\t};\n'
  out += '/* End PBXResourcesBuildPhase section */\n\n'

  // PBXSourcesBuildPhase
  out += '/* Begin PBXSourcesBuildPhase section */\n'
  out += `\t\t${sourcesBuildPhaseUUID} /* Sources */ = {\n`
  out += '\t\t\tisa = PBXSourcesBuildPhase;\n'
  out += '\t\t\tbuildActionMask = 2147483647;\n'
  out += '\t\t\tfiles = (\n'
  for (const bf of buildFiles) {
    out += `\t\t\t\t${bf.uuid} /* ${bf.name} in Sources */,\n`
  }
  out += '\t\t\t);\n'
  out += '\t\t\trunOnlyForDeploymentPostprocessing = 0;\n'
  out += '\t\t};\n'
  out += '/* End PBXSourcesBuildPhase section */\n\n'

  // XCBuildConfiguration
  out += '/* Begin XCBuildConfiguration section */\n'
  // Debug — project level
  out += `\t\t${configDebugProjectUUID} /* Debug */ = {\n`
  out += '\t\t\tisa = XCBuildConfiguration;\n'
  out += '\t\t\tbuildSettings = {\n'
  out += '\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;\n'
  out += '\t\t\t\tCLANG_ENABLE_MODULES = YES;\n'
  out += '\t\t\t\tCOPY_PHASE_STRIP = NO;\n'
  out += '\t\t\t\tDEBUG_INFORMATION_FORMAT = dwarf;\n'
  out += '\t\t\t\tENABLE_STRICT_OBJC_MSGSEND = YES;\n'
  out += '\t\t\t\tENABLE_TESTABILITY = YES;\n'
  out += '\t\t\t\tGCC_OPTIMIZATION_LEVEL = 0;\n'
  out += '\t\t\t\tGCC_PREPROCESSOR_DEFINITIONS = (\n\t\t\t\t\t"DEBUG=1",\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t);\n'
  out += '\t\t\t\tONLY_ACTIVE_ARCH = YES;\n'
  out += `\t\t\t\t${sdkRoot === 'macosx' ? 'SDKROOT = macosx' : 'SDKROOT = iphoneos'};\n`
  out += '\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = "$(inherited) DEBUG";\n'
  out += '\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-Onone";\n'
  out += '\t\t\t};\n'
  out += `\t\t\tname = Debug;\n`
  out += '\t\t};\n'
  // Release — project level
  out += `\t\t${configReleaseProjectUUID} /* Release */ = {\n`
  out += '\t\t\tisa = XCBuildConfiguration;\n'
  out += '\t\t\tbuildSettings = {\n'
  out += '\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;\n'
  out += '\t\t\t\tCLANG_ENABLE_MODULES = YES;\n'
  out += '\t\t\t\tCOPY_PHASE_STRIP = NO;\n'
  out += '\t\t\t\tDEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";\n'
  out += '\t\t\t\tENABLE_NS_ASSERTIONS = NO;\n'
  out += '\t\t\t\tENABLE_STRICT_OBJC_MSGSEND = YES;\n'
  out += `\t\t\t\t${sdkRoot === 'macosx' ? 'SDKROOT = macosx' : 'SDKROOT = iphoneos'};\n`
  out += '\t\t\t\tSWIFT_COMPILATION_MODE = wholemodule;\n'
  out += '\t\t\t};\n'
  out += `\t\t\tname = Release;\n`
  out += '\t\t};\n'
  // Debug — target level
  out += `\t\t${configDebugTargetUUID} /* Debug */ = {\n`
  out += '\t\t\tisa = XCBuildConfiguration;\n'
  out += '\t\t\tbuildSettings = {\n'
  out += `\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;\n`
  out += `\t\t\t\tCODE_SIGN_STYLE = Automatic;\n`
  out += '\t\t\t\tCOMBINE_HIDPI_IMAGES = YES;\n'
  out += `\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n`
  if (teamId) out += `\t\t\t\tDEVELOPMENT_TEAM = ${teamId};\n`
  out += '\t\t\t\tENABLE_PREVIEWS = YES;\n'
  out += '\t\t\t\tGENERATE_INFOPLIST_FILE = YES;\n'
  out += `\t\t\t\tINFOPLIST_KEY_NSHumanReadableCopyright = "";\n`
  out += `\t\t\t\t${deploymentTargetKey} = ${deploymentTarget};\n`
  out += `\t\t\t\tMARKETING_VERSION = 1.0;\n`
  out += `\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = "${bundleId}";\n`
  out += `\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";\n`
  out += `\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;\n`
  out += `\t\t\t\tSWIFT_VERSION = 5.0;\n`
  out += '\t\t\t};\n'
  out += `\t\t\tname = Debug;\n`
  out += '\t\t};\n'
  // Release — target level
  out += `\t\t${configReleaseTargetUUID} /* Release */ = {\n`
  out += '\t\t\tisa = XCBuildConfiguration;\n'
  out += '\t\t\tbuildSettings = {\n'
  out += `\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;\n`
  out += `\t\t\t\tCODE_SIGN_STYLE = Automatic;\n`
  out += '\t\t\t\tCOMBINE_HIDPI_IMAGES = YES;\n'
  out += `\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n`
  if (teamId) out += `\t\t\t\tDEVELOPMENT_TEAM = ${teamId};\n`
  out += '\t\t\t\tENABLE_PREVIEWS = YES;\n'
  out += '\t\t\t\tGENERATE_INFOPLIST_FILE = YES;\n'
  out += `\t\t\t\tINFOPLIST_KEY_NSHumanReadableCopyright = "";\n`
  out += `\t\t\t\t${deploymentTargetKey} = ${deploymentTarget};\n`
  out += `\t\t\t\tMARKETING_VERSION = 1.0;\n`
  out += `\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = "${bundleId}";\n`
  out += `\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";\n`
  out += `\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;\n`
  out += `\t\t\t\tSWIFT_VERSION = 5.0;\n`
  out += '\t\t\t};\n'
  out += `\t\t\tname = Release;\n`
  out += '\t\t};\n'
  out += '/* End XCBuildConfiguration section */\n\n'

  // XCConfigurationList
  out += '/* Begin XCConfigurationList section */\n'
  out += `\t\t${configListProjectUUID} /* Build configuration list for PBXProject "${productName}" */ = {\n`
  out += '\t\t\tisa = XCConfigurationList;\n'
  out += '\t\t\tbuildConfigurations = (\n'
  out += `\t\t\t\t${configDebugProjectUUID} /* Debug */,\n`
  out += `\t\t\t\t${configReleaseProjectUUID} /* Release */,\n`
  out += '\t\t\t);\n'
  out += '\t\t\tdefaultConfigurationIsVisible = 0;\n'
  out += '\t\t\tdefaultConfigurationName = Release;\n'
  out += '\t\t};\n'
  out += `\t\t${configListTargetUUID} /* Build configuration list for PBXNativeTarget "${productName}" */ = {\n`
  out += '\t\t\tisa = XCConfigurationList;\n'
  out += '\t\t\tbuildConfigurations = (\n'
  out += `\t\t\t\t${configDebugTargetUUID} /* Debug */,\n`
  out += `\t\t\t\t${configReleaseTargetUUID} /* Release */,\n`
  out += '\t\t\t);\n'
  out += '\t\t\tdefaultConfigurationIsVisible = 0;\n'
  out += '\t\t\tdefaultConfigurationName = Release;\n'
  out += '\t\t};\n'
  out += '/* End XCConfigurationList section */\n\n'

  out += '\t};\n'
  out += `\trootObject = ${projectUUID} /* Project object */;\n`
  out += '}\n'

  // Write to disk
  const xcodeproj = path.join(projectDir, `${productName}.xcodeproj`)
  fs.mkdirSync(xcodeproj, { recursive: true })
  const pbxprojPath = path.join(xcodeproj, 'project.pbxproj')
  fs.writeFileSync(pbxprojPath, out, 'utf-8')

  // Also ensure workspace data exists
  const wsDir = path.join(xcodeproj, 'project.xcworkspace')
  fs.mkdirSync(wsDir, { recursive: true })
  const wsData = path.join(wsDir, 'contents.xcworkspacedata')
  if (!fs.existsSync(wsData)) {
    fs.writeFileSync(wsData, `<?xml version="1.0" encoding="UTF-8"?>\n<Workspace\n   version = "1.0">\n   <FileRef\n      location = "self:">\n   </FileRef>\n</Workspace>\n`, 'utf-8')
  }

  // Ensure asset catalog Contents.json files exist
  for (const ac of files.xcassets) {
    const acPath = path.join(srcRoot, ac)
    const contentsJson = path.join(acPath, 'Contents.json')
    if (!fs.existsSync(contentsJson)) {
      fs.writeFileSync(contentsJson, '{\n  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n', 'utf-8')
    }
    // AccentColor.colorset
    const accentDir = path.join(acPath, 'AccentColor.colorset')
    if (fs.existsSync(accentDir) && !fs.existsSync(path.join(accentDir, 'Contents.json'))) {
      fs.writeFileSync(path.join(accentDir, 'Contents.json'), '{\n  "colors" : [\n    {\n      "idiom" : "universal"\n    }\n  ],\n  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n', 'utf-8')
    }
    // AppIcon.appiconset
    const iconDir = path.join(acPath, 'AppIcon.appiconset')
    if (fs.existsSync(iconDir) && !fs.existsSync(path.join(iconDir, 'Contents.json'))) {
      fs.writeFileSync(path.join(iconDir, 'Contents.json'), '{\n  "images" : [\n    {\n      "idiom" : "universal",\n      "platform" : "' + (isIOS ? 'ios' : 'macos') + '",\n      "size" : "1024x1024"\n    }\n  ],\n  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n', 'utf-8')
    }
  }

  return {
    pbxproj: out,
    written: true,
    path: pbxprojPath,
    stats: {
      swiftFiles: files.swift.length,
      assetCatalogs: files.xcassets.length,
      totalFileRefs: fileRefs.length,
      groups: groups.length,
    },
  }
}

module.exports = { generateXcodeProject, scanSourceDir, pbxUUID }
