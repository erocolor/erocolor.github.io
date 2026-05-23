#!/bin/bash

# 进入你的博客目录
cd /home/color/amd/erocolor || exit

# 1. 询问文章标题
echo "请输入新文章的标题（将用于文件名和URL）："
read -r title

# 处理标题：将空格替换为连字符，并转为小写（可选）
slug=$(echo "$title" | tr '[:upper:]' '[:lower:]' | sed 's/ /-/g')

# 2. 使用 hugo new 创建文章
echo "正在创建文章：$title ..."
hugo new "posts/$slug.md"

# 3. 用默认编辑器打开新文章供你编辑
echo "打开编辑器，请开始写作..."
# 尝试使用 $EDITOR 环境变量定义的编辑器，若未定义则用 nano
if [ -z "$EDITOR" ]; then
    nano "content/posts/$slug.md"
else
    "$EDITOR" "content/posts/$slug.md"
fi

# 4. 文章编辑完成后，询问是否立即部署
echo "文章已保存。是否立即部署到 GitHub Pages？(y/n)"
read -r deploy_choice

if [ "$deploy_choice" = "y" ] || [ "$deploy_choice" = "Y" ]; then
    echo "请输入本次提交的说明信息："
    read -r commit_msg
    # 这里调用你已有的 deploy 命令，请确保它已在 PATH 中或写出完整路径
    git deploy "$commit_msg"
    echo "部署完成！"
else
    echo "文章已创建并保存，稍后可以手动运行 'deploy' 命令发布。"
fi