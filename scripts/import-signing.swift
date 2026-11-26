import Foundation
import Security

func restore() throws {
    let archive = URL(fileURLWithPath: CommandLine.arguments[1])
    let keychainPath = CommandLine.arguments[2]
    let bytes = try Data(contentsOf: archive)
    var keychain: SecKeychain?
    let opened = SecKeychainOpen(keychainPath, &keychain)
    guard opened == errSecSuccess else {
        throw NSError(domain: "Keychain", code: Int(opened))
    }
    var format = SecExternalFormat.formatPKCS12
    var type = SecExternalItemType.itemTypeAggregate
    var parameters = SecItemImportExportKeyParameters()
    parameters.version = UInt32(SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION)
    parameters.flags = .securePassphrase
    let title = "恢复 Rainbow Mates 固定签名" as CFString
    let prompt = "请输入签名备份的加密密码。" as CFString
    parameters.alertTitle = Unmanaged.passUnretained(title)
    parameters.alertPrompt = Unmanaged.passUnretained(prompt)
    let status = SecItemImport(bytes as CFData, archive.lastPathComponent as CFString, &format, &type, [], &parameters, keychain, nil)
    guard status == errSecSuccess else {
        let message = SecCopyErrorMessageString(status, nil) as String? ?? String(status)
        throw NSError(domain: "Import signing identity", code: Int(status), userInfo: [NSLocalizedDescriptionKey: message])
    }
}
do { try restore() } catch { fputs(error.localizedDescription + "\n", stderr); exit(1) }
