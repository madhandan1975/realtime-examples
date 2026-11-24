require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'VoiceCallSession'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://github.com/madhandan1975/realtime-examples'
  s.author = package['author']
  s.source = { :git => 'https://github.com/madhandan1975/realtime-examples.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/VoiceCallSessionPlugin/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target = '14.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.1'
end
